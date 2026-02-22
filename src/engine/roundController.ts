/**
 * Round Controller - State machine for quiz phases
 *
 * Phases: OPEN -> LOCKED -> REVEAL -> (NEXT) -> OPEN
 */

import type { QuizState, QuizPhase } from "../types/quiz";
import { getQuestion as getLegacyQuestion, getTotalQuestions as getLegacyTotal } from "../content/questions";
import { getPoolQuestion, getPoolEntry, getActivePoolSize, isPoolEmpty } from "../content/bank";
import {
  evaluateAnswers,
  getTopScorers,
  getTopStreaks,
  clearAnswersForQuestion,
  resetAllPlayers,
} from "../state/players";
import { broadcast, getClientCount } from "../sse/broker";

/** Phase durations from environment (in seconds) */
const OPEN_SECONDS = parseInt(process.env.OPEN_SECONDS || "25", 10);
const LOCK_SECONDS = parseInt(process.env.LOCK_SECONDS || "2", 10);
const REVEAL_SECONDS = parseInt(process.env.REVEAL_SECONDS || "12", 10);

/**
 * Get question by index - uses active pool if available, falls back to legacy bank
 */
function getQuestion(index: number) {
  const poolQuestion = getPoolQuestion(index);
  if (poolQuestion) {
    return poolQuestion;
  }
  return getLegacyQuestion(index);
}

/**
 * Get total number of questions - uses active pool if available
 */
function getTotalQuestions(): number {
  const poolSize = getActivePoolSize();
  if (poolSize > 0) {
    return poolSize;
  }
  return getLegacyTotal();
}

/** Controller state */
interface ControllerState {
  running: boolean;
  questionIndex: number;
  phase: QuizPhase;
  endsAtMs: number;
  openStartMs: number;
  timer: NodeJS.Timeout | null;
}

/** Current controller state */
const state: ControllerState = {
  running: false,
  questionIndex: 0,
  phase: "OPEN",
  endsAtMs: 0,
  openStartMs: 0,
  timer: null,
};

function getCurrentDifficulty(): number {
  const poolEntry = getPoolEntry(state.questionIndex);
  if (poolEntry) {
    return poolEntry.difficulty;
  }
  return 3;
}

/**
 * Build QuizState from current controller state
 */
function buildQuizState(): QuizState {
  const questionData = getQuestion(state.questionIndex);
  const isReveal = state.phase === "REVEAL";

  return {
    phase: state.phase,
    endsAtMs: state.endsAtMs,
    questionIndex: state.questionIndex,
    totalQuestions: getTotalQuestions(),
    themeTitle: questionData.themeTitle,
    question: {
      text: questionData.text,
      choices: questionData.choices,
      // Only include correctId during REVEAL phase
      ...(isReveal ? { correctId: questionData.correctId } : {}),
    },
    leaderboard: {
      topScorers: getTopScorers(10),
      topStreaks: getTopStreaks(5),
    },
    teaching: isReveal ? questionData.teaching : undefined,
    ticker: {
      items: generateTickerItems(),
    },
  };
}

/**
 * Generate ticker items based on current state
 */
function generateTickerItems(): string[] {
  const scorers = getTopScorers(1);
  const streakers = getTopStreaks(1);

  const items: string[] = [];

  if (scorers.length > 0) {
    items.push(`Leader: ${scorers[0]!.name} (${scorers[0]!.score})`);
  }

  if (streakers.length > 0) {
    items.push(`Top Streak: ${streakers[0]!.name} 🔥${streakers[0]!.streak}`);
  }

  items.push(`Q${state.questionIndex + 1}/${getTotalQuestions()}`);

  return items;
}

/**
 * Broadcast current state to all clients
 */
function broadcastState(): void {
  const quizState = buildQuizState();
  broadcast(quizState);
}

/**
 * Clear the current timer
 */
function clearTimer(): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/**
 * Schedule the next phase transition
 */
function scheduleNextPhase(delayMs: number, callback: () => void): void {
  clearTimer();
  state.timer = setTimeout(callback, delayMs);
}

/**
 * Transition to OPEN phase
 */
function enterOpenPhase(): void {
  state.phase = "OPEN";
  state.openStartMs = Date.now();
  state.endsAtMs = state.openStartMs + OPEN_SECONDS * 1000;

  console.log(
    `[Controller] OPEN phase - Q${state.questionIndex + 1} (${OPEN_SECONDS}s)`
  );
  broadcastState();

  scheduleNextPhase(OPEN_SECONDS * 1000, enterLockedPhase);
}

/**
 * Transition to LOCKED phase
 */
function enterLockedPhase(): void {
  state.phase = "LOCKED";
  state.endsAtMs = Date.now() + LOCK_SECONDS * 1000;

  console.log(`[Controller] LOCKED phase (${LOCK_SECONDS}s)`);
  broadcastState();

  scheduleNextPhase(LOCK_SECONDS * 1000, enterRevealPhase);
}

/**
 * Transition to REVEAL phase
 */
function enterRevealPhase(): void {
  // Evaluate answers before revealing
  const questionData = getQuestion(state.questionIndex);
  evaluateAnswers(state.questionIndex, questionData.correctId, {
    openStartMs: state.openStartMs,
    openDurationMs: OPEN_SECONDS * 1000,
    difficulty: getCurrentDifficulty(),
  });

  state.phase = "REVEAL";
  state.endsAtMs = Date.now() + REVEAL_SECONDS * 1000;

  console.log(
    `[Controller] REVEAL phase (${REVEAL_SECONDS}s) - Correct: ${questionData.correctId}`
  );
  broadcastState();

  scheduleNextPhase(REVEAL_SECONDS * 1000, advanceToNextQuestion);
}

/**
 * Advance to next question and enter OPEN phase
 */
function advanceToNextQuestion(): void {
  // Clear answers for the completed question
  clearAnswersForQuestion(state.questionIndex);

  // Advance to next question (loop at end)
  state.questionIndex = (state.questionIndex + 1) % getTotalQuestions();

  console.log(`[Controller] Advancing to Q${state.questionIndex + 1}`);

  // Enter OPEN phase for new question
  enterOpenPhase();
}

// ============== Public API ==============

/**
 * Get current quiz state (for /state endpoint)
 */
export function getCurrentState(): QuizState {
  return buildQuizState();
}

/**
 * Check if controller is running
 */
export function isRunning(): boolean {
  return state.running;
}

/**
 * Get current phase
 */
export function getCurrentPhase(): QuizPhase {
  return state.phase;
}

/**
 * Get current question index
 */
export function getQuestionIndex(): number {
  return state.questionIndex;
}

/**
 * Start the controller loop
 */
export function start(): void {
  if (state.running) {
    console.log("[Controller] Already running");
    return;
  }

  state.running = true;
  console.log("[Controller] Starting quiz controller");

  // Start with OPEN phase
  enterOpenPhase();
}

/**
 * Pause the controller (stops timers, keeps state)
 */
export function pause(): void {
  if (!state.running) {
    console.log("[Controller] Not running");
    return;
  }

  clearTimer();
  state.running = false;
  console.log("[Controller] Paused");
}

/**
 * Skip to next question immediately
 */
export function skipToNext(): void {
  if (!state.running) {
    console.log("[Controller] Not running, starting first");
    start();
    return;
  }

  console.log("[Controller] Skipping to next question");
  clearTimer();
  advanceToNextQuestion();
}

/**
 * Reset all scores, streaks, and restart from question 0
 */
export function reset(): void {
  clearTimer();
  state.running = false;
  state.questionIndex = 0;
  state.phase = "OPEN";
  state.endsAtMs = 0;
  state.openStartMs = 0;

  resetAllPlayers();

  console.log("[Controller] Reset complete");
  broadcastState();
}

/**
 * Get controller status for debugging/admin
 */
export function getStatus(): {
  running: boolean;
  phase: QuizPhase;
  questionIndex: number;
  totalQuestions: number;
  endsAtMs: number;
  timeRemainingMs: number;
  connectedClients: number;
} {
  return {
    running: state.running,
    phase: state.phase,
    questionIndex: state.questionIndex,
    totalQuestions: getTotalQuestions(),
    endsAtMs: state.endsAtMs,
    timeRemainingMs: Math.max(0, state.endsAtMs - Date.now()),
    connectedClients: getClientCount(),
  };
}
