/**
 * Round Controller - State machine for quiz phases
 *
 * Phases: OPEN -> LOCKED -> REVEAL -> (NEXT) -> OPEN
 * 
 * Topic Completion Flow:
 * When last question of a topic is REVEALED, the controller:
 * 1. Emits topicComplete event with summary data
 * 2. Optionally auto-advances to next topic after delay
 * 3. Resets scores/streaks for the new topic
 */

import type { QuizState, QuizPhase, TopicCompleteEvent, TopicSummary, TopicStartEvent, TopicCountdownEvent } from "../types/quiz";
import { getQuestion as getLegacyQuestion, getTotalQuestions as getLegacyTotal } from "../content/questions";
import { 
  getPoolQuestion, 
  getPoolEntry, 
  getActivePoolSize, 
  isPoolEmpty,
  getActiveTopicId,
  topicIdToTitle,
  getAllTopicIds,
  setActivePool,
} from "../content/bank";
import { getScoringMode } from "./scoring";
import {
  evaluateAnswers,
  getTopScorers,
  getTopStreaks,
  clearAnswersForQuestion,
  resetAllPlayers,
  getTopScorersWithStreaks,
  getTopStreaksWithScores,
  getTopicStats,
  resetScoresAndStreaks,
  clearPlayerStats,
  clearAllAnswers,
} from "../state/players";
import { broadcast, broadcastEvent, getClientCount } from "../sse/broker";
import {
  getTopicSequenceConfig,
  getNextTopicId,
  getFirstTopicId,
  isLastTopic,
} from "../config/topicSequence";

/** Phase durations from environment (in seconds) */
const OPEN_SECONDS = parseInt(process.env.OPEN_SECONDS || "25", 10);
const LOCK_SECONDS = parseInt(process.env.LOCK_SECONDS || "2", 10);
const REVEAL_SECONDS = parseInt(process.env.REVEAL_SECONDS || "8", 10);

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
  /** Auto-advance timer for topic transitions */
  topicTransitionTimer: NodeJS.Timeout | null;
  /** Whether we're in topic summary display mode */
  inTopicSummary: boolean;
  /** Current topic being displayed in summary (for UI state) */
  summaryTopicId: string | null;
}

/** Current controller state */
const state: ControllerState = {
  running: false,
  questionIndex: 0,
  phase: "OPEN",
  endsAtMs: 0,
  openStartMs: 0,
  timer: null,
  topicTransitionTimer: null,
  inTopicSummary: false,
  summaryTopicId: null,
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
 * Check if current question is the last in the topic/pool
 */
function isLastQuestion(): boolean {
  return state.questionIndex === getTotalQuestions() - 1;
}

/**
 * Build topic summary data for emission
 */
function buildTopicSummary(): TopicSummary {
  const leaders = getTopScorersWithStreaks(10);
  const topStreaks = getTopStreaksWithScores(5);
  const stats = getTopicStats();

  return {
    leaders: leaders.map((l) => ({
      rank: l.rank,
      name: l.name,
      score: l.score,
      streak: l.streak,
    })),
    topStreaks: topStreaks.map((s) => ({
      rank: s.rank,
      name: s.name,
      streak: s.streak,
      score: s.score,
    })),
    stats: {
      averageCorrectPct: stats.averageCorrectPct,
      totalParticipants: stats.totalParticipants,
      maxScore: stats.maxScore,
      questionCount: getTotalQuestions(),
    },
  };
}

/**
 * Emit topic complete event and handle transition
 */
function emitTopicComplete(): void {
  const currentTopicId = getActiveTopicId();
  if (!currentTopicId) {
    console.log("[Controller] No active topic to complete");
    return;
  }

  const config = getTopicSequenceConfig();
  const availableTopics = getAllTopicIds();
  const nextTopicId = getNextTopicId(currentTopicId, availableTopics);
  const seriesComplete = !nextTopicId || isLastTopic(currentTopicId, availableTopics);

  const summary = buildTopicSummary();

  const event: TopicCompleteEvent = {
    type: "topicComplete",
    topicId: currentTopicId,
    topicTitle: topicIdToTitle(currentTopicId),
    summary,
    nextTopicId,
    nextTopicTitle: nextTopicId ? topicIdToTitle(nextTopicId) : null,
    autoAdvanceMs: config.autoAdvance ? config.topicSummaryDisplayTimeMs : 0,
    isSeriesComplete: seriesComplete && !config.loopOnComplete,
  };

  console.log(`[Controller] Topic complete: ${currentTopicId} -> ${nextTopicId ?? "END"}`);
  
  // Update state to show we're in topic summary mode
  state.inTopicSummary = true;
  state.summaryTopicId = currentTopicId;
  
  // Broadcast the topic complete event
  broadcastEvent(event);

  // Schedule auto-advance if enabled and there's a next topic
  if (config.autoAdvance && nextTopicId && config.topicSummaryDisplayTimeMs > 0) {
    clearTopicTransitionTimer();
    state.topicTransitionTimer = setTimeout(() => {
      startNextTopic(nextTopicId);
    }, config.topicSummaryDisplayTimeMs);
    console.log(`[Controller] Auto-advance scheduled in ${config.topicSummaryDisplayTimeMs}ms`);
  }
}

/**
 * Clear topic transition timer
 */
function clearTopicTransitionTimer(): void {
  if (state.topicTransitionTimer) {
    clearTimeout(state.topicTransitionTimer);
    state.topicTransitionTimer = null;
  }
}

/**
 * Start the next topic in sequence
 */
export function startNextTopic(topicId: string): void {
  console.log(`[Controller] Starting next topic: ${topicId}`);
  
  // Clear summary state
  state.inTopicSummary = false;
  state.summaryTopicId = null;
  clearTopicTransitionTimer();
  
  // Reset scores and streaks for new topic (preserve registrations)
  resetScoresAndStreaks();
  clearPlayerStats();
  
  // Set new pool for the topic
  const poolSize = setActivePool([topicId], false); // No shuffle - keep question order
  
  if (poolSize === 0) {
    console.error(`[Controller] No questions found for topic: ${topicId}`);
    return;
  }
  
  // Reset to first question
  state.questionIndex = 0;
  
  // Clear any pending timers
  clearTimer();
  
  // Emit topicStart event so UI can reset its state
  emitTopicStart(topicId);
  
  // Start the quiz for the new topic
  if (state.running) {
    enterOpenPhase();
  } else {
    console.log(`[Controller] Topic loaded but controller not running. Call start() to begin.`);
    // Broadcast current state so UI updates
    broadcastState();
  }
}

/**
 * Advance to next question and enter OPEN phase
 * Handles topic completion when reaching the last question
 */
function advanceToNextQuestion(): void {
  // Clear answers for the completed question
  clearAnswersForQuestion(state.questionIndex);

  // Check if this was the last question in the topic
  if (isLastQuestion()) {
    console.log(`[Controller] Last question completed for topic`);
    emitTopicComplete();
    // Don't advance - wait for topic transition (auto or manual)
    return;
  }

  // Advance to next question
  state.questionIndex = state.questionIndex + 1;

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
  clearTopicTransitionTimer();
  state.running = false;
  state.questionIndex = 0;
  state.phase = "OPEN";
  state.endsAtMs = 0;
  state.openStartMs = 0;
  state.inTopicSummary = false;
  state.summaryTopicId = null;

  resetAllPlayers();
  clearPlayerStats();

  console.log("[Controller] Reset complete");
  broadcastState();
}

/**
 * Handle active pool updates without resetting player scores.
 * Starts from Q1 of the new pool so answer indexing stays consistent.
 */
export function onPoolUpdated(): void {
  state.questionIndex = 0;
  state.inTopicSummary = false;
  state.summaryTopicId = null;
  clearTopicTransitionTimer();

  if (!state.running) {
    state.phase = "OPEN";
    state.endsAtMs = 0;
    state.openStartMs = 0;
    console.log("[Controller] Pool updated (idle) - reset to Q1");
    broadcastState();
    return;
  }

  clearTimer();
  console.log("[Controller] Pool updated (running) - restarting from Q1");
  enterOpenPhase();
}

/**
 * Get controller status for debugging/admin
 */
export function getStatus(): {
  running: boolean;
  phase: QuizPhase;
  questionIndex: number;
  totalQuestions: number;
  questionSource: "active_pool" | "legacy_fallback";
  scoringMode: "flat" | "v2";
  endsAtMs: number;
  timeRemainingMs: number;
  connectedClients: number;
  inTopicSummary: boolean;
  currentTopicId: string | null;
  summaryTopicId: string | null;
} {
  const activePoolSize = getActivePoolSize();
  return {
    running: state.running,
    phase: state.phase,
    questionIndex: state.questionIndex,
    totalQuestions: getTotalQuestions(),
    questionSource: activePoolSize > 0 ? "active_pool" : "legacy_fallback",
    scoringMode: getScoringMode(),
    endsAtMs: state.endsAtMs,
    timeRemainingMs: Math.max(0, state.endsAtMs - Date.now()),
    connectedClients: getClientCount(),
    inTopicSummary: state.inTopicSummary,
    currentTopicId: getActiveTopicId(),
    summaryTopicId: state.summaryTopicId,
  };
}

/**
 * Check if currently in topic summary display mode
 */
export function isInTopicSummary(): boolean {
  return state.inTopicSummary;
}

/**
 * Get pending next topic ID (if in summary and auto-advance scheduled)
 */
export function getPendingNextTopic(): string | null {
  if (!state.inTopicSummary) return null;
  const currentTopicId = state.summaryTopicId || getActiveTopicId();
  if (!currentTopicId) return null;
  return getNextTopicId(currentTopicId, getAllTopicIds());
}

/**
 * Cancel auto-advance and stay on topic summary screen
 * Admin can then manually start next topic when ready
 */
export function cancelAutoAdvance(): void {
  clearTopicTransitionTimer();
  console.log("[Controller] Auto-advance cancelled");
}

/**
 * Emit topic start event to all clients
 */
function emitTopicStart(topicId: string): void {
  const config = getTopicSequenceConfig();
  const availableTopics = getAllTopicIds();
  const sequence = config.topicSequence.length > 0 
    ? config.topicSequence 
    : availableTopics.sort();
  
  const topicIndex = sequence.indexOf(topicId);
  
  const event: TopicStartEvent = {
    type: "topicStart",
    topicId,
    topicTitle: topicIdToTitle(topicId),
    topicIndex: topicIndex >= 0 ? topicIndex : 0,
    totalTopics: sequence.length,
  };
  
  console.log(`[Controller] Emitting topicStart: ${topicId}`);
  broadcastEvent(event);
}

/**
 * Emit topic countdown event and schedule topic start
 */
export function emitTopicCountdown(topicId: string, countdownSeconds: number): void {
  const endsAtMs = Date.now() + (countdownSeconds * 1000);
  
  const event: TopicCountdownEvent = {
    type: "topicCountdown",
    topicId,
    topicTitle: topicIdToTitle(topicId),
    countdownSeconds,
    endsAtMs,
  };
  
  console.log(`[Controller] Emitting topicCountdown: ${countdownSeconds}s for ${topicId}`);
  broadcastEvent(event);
  
  // Clear any existing timers
  clearTimer();
  clearTopicTransitionTimer();
  
  // Schedule topic start after countdown
  state.topicTransitionTimer = setTimeout(() => {
    startNextTopic(topicId);
  }, countdownSeconds * 1000);
}

/**
 * Skip current topic and move to the next without showing summary
 * Resets scores/streaks and starts next topic immediately
 */
export function skipCurrentTopic(): { success: boolean; nextTopicId: string | null } {
  const currentTopicId = state.summaryTopicId || getActiveTopicId();
  
  if (!currentTopicId) {
    console.log("[Controller] No active topic to skip");
    return { success: false, nextTopicId: null };
  }
  
  const nextTopicId = getNextTopicId(currentTopicId, getAllTopicIds());
  
  if (!nextTopicId) {
    console.log("[Controller] No next topic available to skip to");
    return { success: false, nextTopicId: null };
  }
  
  console.log(`[Controller] Skipping topic ${currentTopicId} -> ${nextTopicId}`);
  
  // Clear summary state and timers
  state.inTopicSummary = false;
  state.summaryTopicId = null;
  clearTopicTransitionTimer();
  
  // Start the next topic (this will reset scores/streaks)
  startNextTopic(nextTopicId);
  
  return { success: true, nextTopicId };
}

/**
 * Replay the current topic from the beginning
 * Resets scores/streaks and restarts same topic
 */
export function replayTopic(): { success: boolean; topicId: string | null } {
  const currentTopicId = state.summaryTopicId || getActiveTopicId();
  
  if (!currentTopicId) {
    console.log("[Controller] No active topic to replay");
    return { success: false, topicId: null };
  }
  
  console.log(`[Controller] Replaying topic: ${currentTopicId}`);
  
  // Clear summary state and timers
  state.inTopicSummary = false;
  state.summaryTopicId = null;
  clearTopicTransitionTimer();
  
  // Start the same topic (this will reset scores/streaks)
  startNextTopic(currentTopicId);
  
  return { success: true, topicId: currentTopicId };
}
