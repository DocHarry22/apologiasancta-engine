/**
 * QuizState types for Apologia Sancta Live - Backend
 *
 * This typed state object is sent to frontend via SSE.
 * Must match frontend's QuizState shape exactly.
 */

/** Quiz phase controlled by server */
export type QuizPhase = "OPEN" | "LOCKED" | "REVEAL";

/** Answer choice */
export interface Choice {
  id: string;
  label: string; // A, B, C, D
  text: string;
}

/** Question data */
export interface Question {
  text: string;
  choices: Choice[];
  /** Only present when phase === "REVEAL" */
  correctId?: string;
}

/** Scorer entry in leaderboard */
export interface Scorer {
  rank: number;
  name: string;
  score: number;
}

/** Streaker entry in leaderboard */
export interface Streaker {
  rank: number;
  name: string;
  streak: number;
}

/** Leaderboard data */
export interface Leaderboard {
  topScorers: Scorer[];
  topStreaks: Streaker[];
}

/** Teaching moment content */
export interface Teaching {
  title: string;
  body: string;
  refs: string[];
  isOpenByDefault?: boolean;
}

/** Ticker bar content */
export interface Ticker {
  items: string[];
}

/**
 * Main QuizState - the single source of truth sent to clients.
 */
export interface QuizState {
  /** Current quiz phase */
  phase: QuizPhase;

  /** Unix timestamp (ms) when current phase ends */
  endsAtMs: number;

  /** Current question index (0-based) */
  questionIndex: number;

  /** Total questions in quiz */
  totalQuestions: number;

  /** Theme/topic title */
  themeTitle: string;

  /** Current question data */
  question: Question;

  /** Leaderboard data */
  leaderboard: Leaderboard;

  /** Teaching moment (shown after reveal) */
  teaching?: Teaching;

  /** Ticker bar content */
  ticker?: Ticker;
  
  /** Personalized player data (only in personalized SSE streams) */
  me?: PlayerInfo;
}

/**
 * Personalized player info included in SSE for registered users
 */
export interface PlayerInfo {
  userId: string;
  username: string;
  totalPoints: number;
  streak: number;
  rank?: number;
  distanceToTop10?: number;
}

// ============== Topic Completion Types ==============

/** Summary statistics for a completed topic */
export interface TopicSummaryStats {
  /** Average correct percentage across all participants */
  averageCorrectPct: number;
  /** Total number of participants who answered at least one question */
  totalParticipants: number;
  /** Highest score achieved in this topic */
  maxScore: number;
  /** Total questions in the topic */
  questionCount: number;
}

/** Scorer entry with additional streak info for topic summary */
export interface TopicScorerSummary extends Scorer {
  streak: number;
}

/** Top streak entry for topic summary */
export interface TopicStreakSummary {
  rank: number;
  name: string;
  streak: number;
  score: number;
}

/** Full topic completion summary data */
export interface TopicSummary {
  /** Leaders list (top scorers) */
  leaders: TopicScorerSummary[];
  /** Top streaks with scores */
  topStreaks: TopicStreakSummary[];
  /** Aggregate stats */
  stats: TopicSummaryStats;
}

/** Topic complete event payload sent via SSE */
export interface TopicCompleteEvent {
  type: "topicComplete";
  /** Topic ID that was just completed */
  topicId: string;
  /** Topic display title */
  topicTitle: string;
  /** Summary data for display */
  summary: TopicSummary;
  /** Next topic ID (null if series complete) */
  nextTopicId: string | null;
  /** Next topic display title (null if series complete) */
  nextTopicTitle: string | null;
  /** Time (ms) until auto-advance to next topic (0 = manual only) */
  autoAdvanceMs: number;
  /** Whether this is the last topic in the series */
  isSeriesComplete: boolean;
}

/** Series complete event payload (shown when all topics are done) */
export interface SeriesCompleteEvent {
  type: "seriesComplete";
  /** All topics in the series */
  completedTopics: string[];
  /** Option to restart from beginning */
  canRestart: boolean;
}

/** Topic start event payload sent via SSE when a new topic begins */
export interface TopicStartEvent {
  type: "topicStart";
  /** Topic ID that is starting */
  topicId: string;
  /** Topic display title */
  topicTitle: string;
  /** Index in the sequence (0-based) */
  topicIndex: number;
  /** Total topics in sequence */
  totalTopics: number;
}

/** Topic countdown event payload sent via SSE before topic starts */
export interface TopicCountdownEvent {
  type: "topicCountdown";
  /** Topic ID that will start */
  topicId: string;
  /** Topic display title */
  topicTitle: string;
  /** Countdown duration in seconds */
  countdownSeconds: number;
  /** Unix timestamp (ms) when countdown ends */
  endsAtMs: number;
}

/** Congrats display event - shown after topic completion before countdown */
export interface CongratsEvent {
  type: "congrats";
  /** Topic ID that was just completed */
  topicId: string;
  /** Topic display title */
  topicTitle: string;
  /** Summary data for display */
  summary: TopicSummary;
  /** Duration to display in ms */
  displayDurationMs: number;
  /** Unix timestamp (ms) when congrats ends */
  endsAtMs: number;
  /** Next topic ID (null if series complete) */
  nextTopicId: string | null;
  /** Next topic display title (null if series complete) */
  nextTopicTitle: string | null;
  /** Whether this is the last topic in the series */
  isSeriesComplete: boolean;
}

/** Loop mode configuration */
export type LoopMode = "off" | "once" | "infinite" | number;

/** Repeat/Loop configuration for topic and series */
export interface RepeatConfig {
  /** Loop mode for current topic */
  topicLoopMode: LoopMode;
  /** Remaining topic repeats (for numbered mode) */
  topicRepeatsRemaining: number;
  /** Loop mode for all topics */
  seriesLoopMode: LoopMode;
  /** Remaining series repeats (for numbered mode) */
  seriesRepeatsRemaining: number;
}
