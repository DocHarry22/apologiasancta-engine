/**
 * Round Controller - State machine for quiz phases
 *
 * Phases: OPEN -> LOCKED -> REVEAL -> (NEXT) -> OPEN
 * 
 * Topic Completion Flow:
 * When last question of a topic is REVEALED, the controller:
 * 1. Emits congrats event (5s display)
 * 2. After congrats, emits countdown event (10s default)
 * 3. After countdown, starts next topic
 * 4. Handles repeat/loop modes for topic and series
 */

import type { QuizState, QuizPhase, TopicCompleteEvent, TopicSummary, TopicStartEvent, TopicCountdownEvent, CongratsEvent } from "../types/quiz";
import { getQuestion as getLegacyQuestion, getTotalQuestions as getLegacyTotal } from "../content/questions";
import { 
  getPoolQuestion, 
  getPoolEntry, 
  getActivePoolSize, 
  getActiveTopicId,
  topicIdToTitle,
  getAllTopicIds,
  setActivePoolForRoom,
} from "../content/bank";
import { getScoringMode } from "./scoring";
import {
  evaluateAnswers,
  getTopScorers,
  getTopStreaks,
  clearAnswersForQuestion,
  getTopScorersWithStreaks,
  getTopStreaksWithScores,
  getTopicStats,
  resetScoresAndStreaks,
  clearPlayerStats,
  clearAllAnswers,
} from "../state/players";
import { broadcast, broadcastEvent, getClientCount, getClientCountForRoom } from "../sse/broker";
import { DEFAULT_ROOM_ID, listRooms } from "../state/rooms";
import {
  getTopicSequenceConfig,
  getNextTopicId,
  getFirstTopicId,
  isLastTopic,
  shouldRepeatTopic,
  shouldRepeatSeries,
  setTopicLoopMode,
  setSeriesLoopMode,
  setCountdownSeconds,
} from "../config/topicSequence";
import { schedulePersistence } from "../state/persistence";

/** Phase durations from environment (in seconds) */
const OPEN_SECONDS = parseInt(process.env.OPEN_SECONDS || "25", 10);
const LOCK_SECONDS = parseInt(process.env.LOCK_SECONDS || "2", 10);
const REVEAL_SECONDS = parseInt(process.env.REVEAL_SECONDS || "8", 10);

/**
 * Get question by index - uses active pool if available, falls back to legacy bank
 */
function getQuestion(index: number, roomId: string = DEFAULT_ROOM_ID) {
  const poolQuestion = getPoolQuestion(index, roomId);
  if (poolQuestion) {
    return poolQuestion;
  }
  return getLegacyQuestion(index);
}

/**
 * Get total number of questions - uses active pool if available
 */
function getTotalQuestions(roomId: string = DEFAULT_ROOM_ID): number {
  const poolSize = getActivePoolSize(roomId);
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
  /** Congrats display timer */
  congratsTimer: NodeJS.Timeout | null;
  /** Countdown timer before next topic */
  countdownTimer: NodeJS.Timeout | null;
  /** Auto-advance timer for topic transitions */
  topicTransitionTimer: NodeJS.Timeout | null;
  /** Whether we're showing congrats message */
  inCongrats: boolean;
  /** Whether we're in countdown mode */
  inCountdown: boolean;
  /** Whether we're in topic summary display mode */
  inTopicSummary: boolean;
  /** Current topic being displayed in summary (for UI state) */
  summaryTopicId: string | null;
  /** Pending next topic ID for transition */
  pendingNextTopicId: string | null;
}

export interface PersistedControllerSnapshot {
  rooms: Array<{
    roomId: string;
    running: boolean;
    questionIndex: number;
    phase: QuizPhase;
    endsAtMs: number;
    openStartMs: number;
    inCongrats: boolean;
    inCountdown: boolean;
    inTopicSummary: boolean;
    summaryTopicId: string | null;
    pendingNextTopicId: string | null;
  }>;
}

function createControllerState(): ControllerState {
  return {
    running: false,
    questionIndex: 0,
    phase: "OPEN",
    endsAtMs: 0,
    openStartMs: 0,
    timer: null,
    congratsTimer: null,
    countdownTimer: null,
    topicTransitionTimer: null,
    inCongrats: false,
    inCountdown: false,
    inTopicSummary: false,
    summaryTopicId: null,
    pendingNextTopicId: null,
  };
}

const controllerStates: Map<string, ControllerState> = new Map();

function getControllerState(roomId: string = DEFAULT_ROOM_ID): ControllerState {
  let state = controllerStates.get(roomId);
  if (!state) {
    state = createControllerState();
    controllerStates.set(roomId, state);
  }
  return state;
}

function getCurrentDifficulty(roomId: string = DEFAULT_ROOM_ID): number {
  const state = getControllerState(roomId);
  const poolEntry = getPoolEntry(state.questionIndex, roomId);
  if (poolEntry) {
    return poolEntry.difficulty;
  }
  return 3;
}

function getGameplayRoomIds(): string[] {
  return listRooms(false).map((room) => room.roomId);
}

/**
 * Build QuizState from current controller state
 */
function buildQuizState(roomId: string = DEFAULT_ROOM_ID): QuizState {
  const state = getControllerState(roomId);
  const questionData = getQuestion(state.questionIndex, roomId);
  const isReveal = state.phase === "REVEAL";

  return {
    phase: state.phase,
    endsAtMs: state.endsAtMs,
    questionIndex: state.questionIndex,
    totalQuestions: getTotalQuestions(roomId),
    themeTitle: questionData.themeTitle,
    question: {
      text: questionData.text,
      choices: questionData.choices,
      // Only include correctId during REVEAL phase
      ...(isReveal ? { correctId: questionData.correctId } : {}),
    },
    leaderboard: {
      topScorers: getTopScorers(10, roomId),
      topStreaks: getTopStreaks(5, roomId),
    },
    teaching: isReveal ? questionData.teaching : undefined,
    ticker: {
      items: generateTickerItems(roomId),
    },
  };
}

/**
 * Generate ticker items based on current state
 */
function generateTickerItems(roomId: string = DEFAULT_ROOM_ID): string[] {
  const state = getControllerState(roomId);
  const scorers = getTopScorers(1, roomId);
  const streakers = getTopStreaks(1, roomId);

  const items: string[] = [];

  if (scorers.length > 0) {
    items.push(`Leader: ${scorers[0]!.name} (${scorers[0]!.score})`);
  }

  if (streakers.length > 0) {
    items.push(`Top Streak: ${streakers[0]!.name} 🔥${streakers[0]!.streak}`);
  }

  items.push(`Q${state.questionIndex + 1}/${getTotalQuestions(roomId)}`);

  return items;
}

/**
 * Broadcast current state to all clients in the given room
 */
function broadcastState(roomId: string = DEFAULT_ROOM_ID): void {
  broadcast(roomId);
}

function markControllerChanged(): void {
  schedulePersistence();
}

/**
 * Clear the current timer
 */
function clearTimer(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/**
 * Schedule the next phase transition
 */
function scheduleNextPhase(roomId: string, delayMs: number, callback: () => void): void {
  const state = getControllerState(roomId);
  clearTimer(roomId);
  state.timer = setTimeout(callback, delayMs);
}

/**
 * Transition to OPEN phase
 */
function enterOpenPhase(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  state.phase = "OPEN";
  state.openStartMs = Date.now();
  state.endsAtMs = state.openStartMs + OPEN_SECONDS * 1000;
  markControllerChanged();

  console.log(
    `[Controller] OPEN phase - Q${state.questionIndex + 1} (${OPEN_SECONDS}s)`
  );
  broadcastState(roomId);

  scheduleNextPhase(roomId, OPEN_SECONDS * 1000, () => enterLockedPhase(roomId));
}

/**
 * Transition to LOCKED phase
 */
function enterLockedPhase(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  state.phase = "LOCKED";
  state.endsAtMs = Date.now() + LOCK_SECONDS * 1000;
  markControllerChanged();

  console.log(`[Controller] LOCKED phase (${LOCK_SECONDS}s)`);
  broadcastState(roomId);

  scheduleNextPhase(roomId, LOCK_SECONDS * 1000, () => enterRevealPhase(roomId));
}

/**
 * Transition to REVEAL phase
 */
function enterRevealPhase(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  // Evaluate answers before revealing
  const questionData = getQuestion(state.questionIndex, roomId);
  evaluateAnswers(
    state.questionIndex,
    questionData.correctId,
    {
      openStartMs: state.openStartMs,
      openDurationMs: OPEN_SECONDS * 1000,
      difficulty: getCurrentDifficulty(roomId),
    },
    roomId
  );

  state.phase = "REVEAL";
  state.endsAtMs = Date.now() + REVEAL_SECONDS * 1000;
  markControllerChanged();

  console.log(
    `[Controller] REVEAL phase (${REVEAL_SECONDS}s) - Correct: ${questionData.correctId}`
  );
  broadcastState(roomId);

  scheduleNextPhase(roomId, REVEAL_SECONDS * 1000, () => advanceToNextQuestion(roomId));
}

/**
 * Check if current question is the last in the topic/pool
 */
function isLastQuestion(roomId: string = DEFAULT_ROOM_ID): boolean {
  const state = getControllerState(roomId);
  return state.questionIndex === getTotalQuestions(roomId) - 1;
}

/**
 * Build topic summary data for emission
 */
function buildTopicSummary(roomId?: string): TopicSummary {
  const leaders = getTopScorersWithStreaks(10, roomId);
  const topStreaks = getTopStreaksWithScores(5, roomId);
  const stats = getTopicStats(roomId);

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
      questionCount: getTotalQuestions(roomId),
    },
  };
}

/**
 * Determine the next topic based on repeat/loop settings
 */
function determineNextTopic(currentTopicId: string, roomId: string = DEFAULT_ROOM_ID): string | null {
  const availableTopics = getAllTopicIds();
  
  // Check if we should repeat the current topic
  if (shouldRepeatTopic(roomId)) {
    console.log(`[Controller] Topic loop mode active - repeating ${currentTopicId}`);
    return currentTopicId;
  }
  
  // Check for next topic in sequence
  const nextTopicId = getNextTopicId(currentTopicId, availableTopics, roomId);
  
  // If series complete, check if we should loop
  if (!nextTopicId && shouldRepeatSeries(roomId)) {
    console.log(`[Controller] Series loop mode active - restarting from first topic`);
    return getFirstTopicId(availableTopics, roomId);
  }
  
  return nextTopicId;
}

/**
 * Clear all topic transition timers
 */
function clearAllTransitionTimers(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  if (state.congratsTimer) {
    clearTimeout(state.congratsTimer);
    state.congratsTimer = null;
  }
  if (state.countdownTimer) {
    clearTimeout(state.countdownTimer);
    state.countdownTimer = null;
  }
  if (state.topicTransitionTimer) {
    clearTimeout(state.topicTransitionTimer);
    state.topicTransitionTimer = null;
  }
}

/**
 * Emit congrats event and schedule countdown
 */
function emitCongratsAndScheduleCountdown(
  currentTopicId: string,
  nextTopicId: string | null,
  isSeriesComplete: boolean,
  roomId: string = DEFAULT_ROOM_ID
): void {
  const config = getTopicSequenceConfig(roomId);
  const state = getControllerState(roomId);

  console.log(`[Controller] Emitting congrats for ${currentTopicId} (${config.congratsDisplayTimeMs}ms)`);
  
  state.inCongrats = true;
  state.pendingNextTopicId = nextTopicId;
  markControllerChanged();
  const congratsEvent: CongratsEvent = {
    type: "congrats",
    topicId: currentTopicId,
    topicTitle: topicIdToTitle(currentTopicId),
    summary: buildTopicSummary(roomId),
    displayDurationMs: config.congratsDisplayTimeMs,
    endsAtMs: Date.now() + config.congratsDisplayTimeMs,
    nextTopicId,
    nextTopicTitle: nextTopicId ? topicIdToTitle(nextTopicId) : null,
    isSeriesComplete,
  };

  broadcastEvent(congratsEvent, roomId);
  
  // Schedule countdown after congrats (if auto-advance enabled and next topic exists)
  if (config.autoAdvance && nextTopicId) {
    state.congratsTimer = setTimeout(() => {
      state.inCongrats = false;
      markControllerChanged();
      emitCountdownForTopic(nextTopicId, roomId);
    }, config.congratsDisplayTimeMs);
  }
}

/**
 * Emit countdown event and schedule topic start
 */
function emitCountdownForTopic(topicId: string, roomId: string = DEFAULT_ROOM_ID): void {
  const config = getTopicSequenceConfig(roomId);
  const countdownSeconds = config.countdownSeconds;
  const state = getControllerState(roomId);
  
  const event: TopicCountdownEvent = {
    type: "topicCountdown",
    topicId,
    topicTitle: topicIdToTitle(topicId),
    countdownSeconds,
    endsAtMs: Date.now() + (countdownSeconds * 1000),
  };
  
  console.log(`[Controller] Emitting countdown (${countdownSeconds}s) for ${topicId}`);
  
  state.inCountdown = true;
  markControllerChanged();
  broadcastEvent(event, roomId);
  
  // Schedule topic start after countdown
  state.countdownTimer = setTimeout(() => {
    state.inCountdown = false;
    markControllerChanged();
    startNextTopic(topicId, roomId);
  }, countdownSeconds * 1000);
}

/**
 * Emit topic complete event and handle transition
 * Flow: topicComplete → congrats (5s) → countdown (10s) → next topic
 */
function emitTopicComplete(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  const currentTopicId = getActiveTopicId(roomId);
  if (!currentTopicId) {
    console.log("[Controller] No active topic to complete");
    return;
  }

  const config = getTopicSequenceConfig(roomId);
  // Determine next topic (considers repeat/loop settings)
  const nextTopicId = determineNextTopic(currentTopicId, roomId);
  const availableTopics = getAllTopicIds();
  const isSeriesComplete = !nextTopicId && isLastTopic(currentTopicId, availableTopics, roomId);

  // Legacy topicComplete event for backwards compatibility
  console.log(`[Controller] Topic complete: ${currentTopicId} -> ${nextTopicId ?? "END"}`);
  
  // Update state to show we're in topic summary mode
  state.inTopicSummary = true;
  state.summaryTopicId = currentTopicId;
  markControllerChanged();
  
  // Broadcast the topic complete event (for backwards compat)
  const event: TopicCompleteEvent = {
    type: "topicComplete",
    topicId: currentTopicId,
    topicTitle: topicIdToTitle(currentTopicId),
    summary: buildTopicSummary(roomId),
    nextTopicId,
    nextTopicTitle: nextTopicId ? topicIdToTitle(nextTopicId) : null,
    autoAdvanceMs: config.autoAdvance ? (config.congratsDisplayTimeMs + config.countdownSeconds * 1000) : 0,
    isSeriesComplete,
  };
  broadcastEvent(event, roomId);

  // Start the congrats → countdown → next topic flow
  clearAllTransitionTimers(roomId);
  emitCongratsAndScheduleCountdown(currentTopicId, nextTopicId, isSeriesComplete, roomId);
}

/**
 * Clear topic transition timer
 */
function clearTopicTransitionTimer(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  if (state.topicTransitionTimer) {
    clearTimeout(state.topicTransitionTimer);
    state.topicTransitionTimer = null;
  }
}

/**
 * Start the next topic in sequence
 */
export function startNextTopic(topicId: string, roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  console.log(`[Controller] Starting next topic: ${topicId}`);
  
  // Clear all transition state
  state.inTopicSummary = false;
  state.summaryTopicId = null;
  state.inCongrats = false;
  state.inCountdown = false;
  state.pendingNextTopicId = null;
  clearAllTransitionTimers(roomId);
  
  // Reset scores and streaks for new topic (preserve registrations)
  resetScoresAndStreaks(roomId);
  clearPlayerStats(roomId);
  clearAllAnswers(roomId);
  
  // Set new pool for the topic
  const poolSize = setActivePoolForRoom([topicId], false, roomId); // No shuffle - keep question order
  
  if (poolSize === 0) {
    console.error(`[Controller] No questions found for topic: ${topicId}`);
    return;
  }
  
  // Reset to first question
  state.questionIndex = 0;
  markControllerChanged();
  
  // Clear any pending timers
  clearTimer(roomId);
  
  // Emit topicStart event so UI can reset its state
  emitTopicStart(topicId, roomId);
  
  // Start the quiz for the new topic
  if (state.running) {
    enterOpenPhase(roomId);
  } else {
    console.log(`[Controller] Topic loaded but controller not running. Call start() to begin.`);
    // Broadcast current state so UI updates
    broadcastState(roomId);
  }
}

/**
 * Advance to next question and enter OPEN phase
 * Handles topic completion when reaching the last question
 */
function advanceToNextQuestion(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  // Clear answers for the completed question
  clearAnswersForQuestion(state.questionIndex, roomId);

  // Check if this was the last question in the topic
  if (isLastQuestion(roomId)) {
    console.log(`[Controller] Last question completed for topic`);
    emitTopicComplete(roomId);
    // Don't advance - wait for topic transition (auto or manual)
    return;
  }

  // Advance to next question
  state.questionIndex = state.questionIndex + 1;

  console.log(`[Controller] Advancing to Q${state.questionIndex + 1}`);

  // Enter OPEN phase for new question
  enterOpenPhase(roomId);
}

// ============== Public API ==============

export type AnswerWindowReason = "game_paused" | "not_started" | "locked" | "too_late";

export type AnswerWindowStatus = {
  accepting: boolean;
  reason?: AnswerWindowReason;
  phase: QuizPhase;
  questionIndex: number;
  openStartMs: number;
  endsAtMs: number;
};

/**
 * Authoritative server-side answer window check.
 *
 * The phase timer callback can be delayed when the event loop is busy, so
 * checking phase alone is not sufficient. This function also rejects paused,
 * unstarted, early, and deadline-expired submissions using server time.
 */
export function getAnswerWindowStatus(
  roomId: string = DEFAULT_ROOM_ID,
  nowMs: number = Date.now()
): AnswerWindowStatus {
  const state = getControllerState(roomId);
  const snapshot = {
    phase: state.phase,
    questionIndex: state.questionIndex,
    openStartMs: state.openStartMs,
    endsAtMs: state.endsAtMs,
  };

  if (!state.running) {
    return { ...snapshot, accepting: false, reason: "game_paused" };
  }

  if (state.phase !== "OPEN") {
    return { ...snapshot, accepting: false, reason: "locked" };
  }

  if (state.openStartMs <= 0 || state.endsAtMs <= state.openStartMs || nowMs < state.openStartMs) {
    return { ...snapshot, accepting: false, reason: "not_started" };
  }

  if (nowMs >= state.endsAtMs) {
    return { ...snapshot, accepting: false, reason: "too_late" };
  }

  return { ...snapshot, accepting: true };
}

/**
 * Get current quiz state (for /state endpoint)
 */
export function getCurrentState(roomId: string = DEFAULT_ROOM_ID): QuizState {
  return buildQuizState(roomId);
}

/**
 * Check if controller is running
 */
export function isRunning(roomId: string = DEFAULT_ROOM_ID): boolean {
  return getControllerState(roomId).running;
}

/**
 * Get current phase
 */
export function getCurrentPhase(roomId: string = DEFAULT_ROOM_ID): QuizPhase {
  return getControllerState(roomId).phase;
}

/**
 * Get current question index
 */
export function getQuestionIndex(roomId: string = DEFAULT_ROOM_ID): number {
  return getControllerState(roomId).questionIndex;
}

/**
 * Start the controller loop
 */
export function start(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  if (state.running) {
    console.log("[Controller] Already running");
    return;
  }

  state.running = true;
  markControllerChanged();
  console.log("[Controller] Starting quiz controller");

  // Start with OPEN phase
  enterOpenPhase(roomId);
}

/**
 * Pause the controller (stops timers, keeps state)
 */
export function pause(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  if (!state.running) {
    console.log("[Controller] Not running");
    return;
  }

  clearTimer(roomId);
  state.running = false;
  state.endsAtMs = 0;
  markControllerChanged();
  console.log("[Controller] Paused");
}

/**
 * Skip to next question immediately
 */
export function skipToNext(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  if (!state.running) {
    console.log("[Controller] Not running, starting first");
    start(roomId);
    return;
  }

  console.log("[Controller] Skipping to next question");
  clearTimer(roomId);
  advanceToNextQuestion(roomId);
}

/**
 * Reset all scores, streaks, and restart from question 0
 */
export function reset(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  clearTimer(roomId);
  clearTopicTransitionTimer(roomId);
  state.running = false;
  state.questionIndex = 0;
  state.phase = "OPEN";
  state.endsAtMs = 0;
  state.openStartMs = 0;
  state.inTopicSummary = false;
  state.summaryTopicId = null;
  state.inCongrats = false;
  state.inCountdown = false;
  state.pendingNextTopicId = null;

  resetScoresAndStreaks(roomId);
  clearPlayerStats(roomId);
  clearAllAnswers(roomId);
  markControllerChanged();

  console.log("[Controller] Reset complete");
  broadcastState(roomId);
}

/**
 * Handle active pool updates without resetting player scores.
 * Starts from Q1 of the new pool so answer indexing stays consistent.
 */
export function onPoolUpdated(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  state.questionIndex = 0;
  state.inTopicSummary = false;
  state.summaryTopicId = null;
  state.inCongrats = false;
  state.inCountdown = false;
  state.pendingNextTopicId = null;
  clearTopicTransitionTimer(roomId);

  if (!state.running) {
    state.phase = "OPEN";
    state.endsAtMs = 0;
    state.openStartMs = 0;
    markControllerChanged();
    console.log("[Controller] Pool updated (idle) - reset to Q1");
    broadcastState(roomId);
    return;
  }

  clearTimer(roomId);
  markControllerChanged();
  console.log("[Controller] Pool updated (running) - restarting from Q1");
  enterOpenPhase(roomId);
}

/**
 * Get controller status for debugging/admin
 */
export function getStatus(roomId: string = DEFAULT_ROOM_ID): {
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
  const state = getControllerState(roomId);
  const activePoolSize = getActivePoolSize(roomId);
  return {
    running: state.running,
    phase: state.phase,
    questionIndex: state.questionIndex,
    totalQuestions: getTotalQuestions(roomId),
    questionSource: activePoolSize > 0 ? "active_pool" : "legacy_fallback",
    scoringMode: getScoringMode(),
    endsAtMs: state.endsAtMs,
    timeRemainingMs: Math.max(0, state.endsAtMs - Date.now()),
    connectedClients: roomId === DEFAULT_ROOM_ID ? getClientCount() : getClientCountForRoom(roomId),
    inTopicSummary: state.inTopicSummary,
    currentTopicId: getActiveTopicId(roomId),
    summaryTopicId: state.summaryTopicId,
  };
}

/**
 * Check if currently in topic summary display mode
 */
export function isInTopicSummary(roomId: string = DEFAULT_ROOM_ID): boolean {
  return getControllerState(roomId).inTopicSummary;
}

/**
 * Get pending next topic ID (if in summary and auto-advance scheduled)
 */
export function getPendingNextTopic(roomId: string = DEFAULT_ROOM_ID): string | null {
  const state = getControllerState(roomId);
  if (!state.inTopicSummary) return null;
  const currentTopicId = state.summaryTopicId || getActiveTopicId(roomId);
  if (!currentTopicId) return null;
  return getNextTopicId(currentTopicId, getAllTopicIds(), roomId);
}

/**
 * Cancel auto-advance and stay on topic summary screen
 * Admin can then manually start next topic when ready
 */
export function cancelAutoAdvance(roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  clearAllTransitionTimers(roomId);
  state.inCongrats = false;
  state.inCountdown = false;
  state.pendingNextTopicId = null;
  markControllerChanged();
  console.log("[Controller] Auto-advance cancelled");
}

/**
 * Emit topic start event to all clients
 */
function emitTopicStart(topicId: string, roomId: string = DEFAULT_ROOM_ID): void {
  const config = getTopicSequenceConfig(roomId);
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
  broadcastEvent(event, roomId);
}

/**
 * Emit topic countdown event and schedule topic start
 */
export function emitTopicCountdown(topicId: string, countdownSeconds: number, roomId: string = DEFAULT_ROOM_ID): void {
  const state = getControllerState(roomId);
  const endsAtMs = Date.now() + (countdownSeconds * 1000);
  
  const event: TopicCountdownEvent = {
    type: "topicCountdown",
    topicId,
    topicTitle: topicIdToTitle(topicId),
    countdownSeconds,
    endsAtMs,
  };
  
  console.log(`[Controller] Emitting topicCountdown: ${countdownSeconds}s for ${topicId}`);
  broadcastEvent(event, roomId);
  
  // Clear any existing timers
  clearTimer(roomId);
  clearTopicTransitionTimer(roomId);
  markControllerChanged();
  
  // Schedule topic start after countdown
  state.topicTransitionTimer = setTimeout(() => {
    startNextTopic(topicId, roomId);
  }, countdownSeconds * 1000);
}

/**
 * Skip current topic and move to the next without showing summary
 * Resets scores/streaks and starts next topic immediately
 */
export function skipCurrentTopic(roomId: string = DEFAULT_ROOM_ID): { success: boolean; nextTopicId: string | null } {
  const state = getControllerState(roomId);
  const currentTopicId = state.summaryTopicId || getActiveTopicId(roomId);
  
  if (!currentTopicId) {
    console.log("[Controller] No active topic to skip");
    return { success: false, nextTopicId: null };
  }
  
  const nextTopicId = getNextTopicId(currentTopicId, getAllTopicIds(), roomId);
  
  if (!nextTopicId) {
    console.log("[Controller] No next topic available to skip to");
    return { success: false, nextTopicId: null };
  }
  
  console.log(`[Controller] Skipping topic ${currentTopicId} -> ${nextTopicId}`);
  
  // Clear summary state and timers
  state.inTopicSummary = false;
  state.summaryTopicId = null;
  clearTopicTransitionTimer(roomId);
  markControllerChanged();
  
  // Start the next topic (this will reset scores/streaks)
  startNextTopic(nextTopicId, roomId);
  
  return { success: true, nextTopicId };
}

/**
 * Replay the current topic from the beginning
 * Resets scores/streaks and restarts same topic
 */
export function replayTopic(roomId: string = DEFAULT_ROOM_ID): { success: boolean; topicId: string | null } {
  const state = getControllerState(roomId);
  const currentTopicId = state.summaryTopicId || getActiveTopicId(roomId);
  
  if (!currentTopicId) {
    console.log("[Controller] No active topic to replay");
    return { success: false, topicId: null };
  }
  
  console.log(`[Controller] Replaying topic: ${currentTopicId}`);
  
  // Clear summary state and timers
  state.inTopicSummary = false;
  state.summaryTopicId = null;
  clearTopicTransitionTimer(roomId);
  markControllerChanged();
  
  // Start the same topic (this will reset scores/streaks)
  startNextTopic(currentTopicId, roomId);
  
  return { success: true, topicId: currentTopicId };
}

export function getControllerPersistenceSnapshot(): PersistedControllerSnapshot {
  return {
    rooms: [...controllerStates.entries()].map(([roomId, state]) => ({
      roomId,
      running: state.running,
      questionIndex: state.questionIndex,
      phase: state.phase,
      endsAtMs: state.endsAtMs,
      openStartMs: state.openStartMs,
      inCongrats: state.inCongrats,
      inCountdown: state.inCountdown,
      inTopicSummary: state.inTopicSummary,
      summaryTopicId: state.summaryTopicId,
      pendingNextTopicId: state.pendingNextTopicId,
    })),
  };
}

export function hydrateControllerPersistenceSnapshot(
  snapshot: PersistedControllerSnapshot | null | undefined
): void {
  controllerStates.forEach((_state, roomId) => {
    clearTimer(roomId);
    clearAllTransitionTimers(roomId);
  });
  controllerStates.clear();

  const persistedRooms = snapshot?.rooms;
  if (persistedRooms && persistedRooms.length > 0) {
    for (const persistedState of persistedRooms) {
      const state = createControllerState();
      state.running = false;
      state.questionIndex = Math.max(0, persistedState.questionIndex ?? 0);
      state.phase = "OPEN";
      state.endsAtMs = 0;
      state.openStartMs = 0;
      state.inCongrats = false;
      state.inCountdown = false;
      state.inTopicSummary = persistedState.inTopicSummary ?? false;
      state.summaryTopicId = persistedState.summaryTopicId ?? null;
      state.pendingNextTopicId = state.inTopicSummary ? persistedState.pendingNextTopicId ?? null : null;

      const maxIndex = Math.max(0, getTotalQuestions(persistedState.roomId) - 1);
      state.questionIndex = Math.min(state.questionIndex, maxIndex);
      controllerStates.set(persistedState.roomId, state);
    }
    return;
  }

  const legacyState = createControllerState();
  legacyState.running = false;
  legacyState.questionIndex = 0;
  controllerStates.set(DEFAULT_ROOM_ID, legacyState);
}
