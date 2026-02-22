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
