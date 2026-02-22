/**
 * Scoring Module - Handles score calculation and streak tracking
 */

import type { Scorer, Streaker } from "../types/quiz";

export interface ScoreResult {
  score: number;
  isCorrect: boolean;
  streak: number;
  previousStreak: number;
}

export type ScoringMode = "flat" | "v2";

export const POINTS_PER_CORRECT = 10;

const RAW_SCORING_MODE = (process.env.SCORING_MODE || "flat").toLowerCase();
const SCORING_MODE: ScoringMode = RAW_SCORING_MODE === "v2" ? "v2" : "flat";

const DIFFICULTY_BONUS: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 0,
  2: 2,
  3: 4,
  4: 7,
  5: 10,
};

export interface ScoreCalculationInput {
  isCorrect: boolean;
  difficulty?: number | "easy" | "medium" | "hard";
  answerTimeMs?: number;
  openStartMs?: number;
  openDurationMs?: number;
}

export interface ScoreCalculationDetails {
  mode: ScoringMode;
  score: number;
  basePoints: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
  difficultyBonus: number;
  subtotal: number;
  f: number;
  multiplier: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeDifficulty(difficulty?: number | "easy" | "medium" | "hard"): 1 | 2 | 3 | 4 | 5 {
  if (typeof difficulty === "number" && Number.isFinite(difficulty)) {
    const rounded = Math.round(difficulty);
    return clamp(rounded, 1, 5) as 1 | 2 | 3 | 4 | 5;
  }

  if (difficulty === "easy") return 2;
  if (difficulty === "hard") return 4;
  if (difficulty === "medium") return 3;

  return 3;
}

export function getScoringMode(): ScoringMode {
  return SCORING_MODE;
}

export function calculateScoreDetails(input: ScoreCalculationInput): ScoreCalculationDetails {
  const basePoints = POINTS_PER_CORRECT;
  const difficulty = normalizeDifficulty(input.difficulty);
  const difficultyBonus = DIFFICULTY_BONUS[difficulty];
  const subtotal = basePoints + difficultyBonus;

  const openDurationMs = input.openDurationMs && input.openDurationMs > 0
    ? input.openDurationMs
    : 1;

  const openStartMs = input.openStartMs ?? input.answerTimeMs ?? Date.now();
  const answerTimeMs = input.answerTimeMs ?? openStartMs;
  const rawFraction = (answerTimeMs - openStartMs) / openDurationMs;
  const f = clamp(rawFraction, 0, 1);
  const multiplier = 1 + 0.5 * (1 - f) * (1 - f);

  if (!input.isCorrect) {
    return {
      mode: SCORING_MODE,
      score: 0,
      basePoints,
      difficulty,
      difficultyBonus,
      subtotal,
      f,
      multiplier,
    };
  }

  if (SCORING_MODE === "flat") {
    return {
      mode: SCORING_MODE,
      score: basePoints,
      basePoints,
      difficulty,
      difficultyBonus,
      subtotal,
      f,
      multiplier,
    };
  }

  return {
    mode: SCORING_MODE,
    score: Math.round(subtotal * multiplier),
    basePoints,
    difficulty,
    difficultyBonus,
    subtotal,
    f,
    multiplier,
  };
}

/**
 * Calculate score for a correct answer
 * Currently fixed at 10 points per correct answer
 */
export function calculateScore(isCorrect: boolean): number;
export function calculateScore(input: ScoreCalculationInput): number;
export function calculateScore(isCorrectOrInput: boolean | ScoreCalculationInput): number {
  if (typeof isCorrectOrInput === "boolean") {
    return isCorrectOrInput ? POINTS_PER_CORRECT : 0;
  }

  return calculateScoreDetails(isCorrectOrInput).score;
}

/**
 * Update streak count
 * Returns new streak value
 */
export function updateStreak(
  currentStreak: number,
  isCorrect: boolean
): number {
  if (isCorrect) {
    return currentStreak + 1;
  }
  return 0; // Reset streak on incorrect answer
}

/**
 * Build scorers leaderboard from player scores
 * Sorted by score descending, returns top N
 */
export function buildScorersLeaderboard(
  players: Map<string, { name: string; score: number }>,
  limit: number = 10
): Scorer[] {
  const scorers: Array<{ name: string; score: number }> = [];

  players.forEach(({ name, score }) => {
    scorers.push({ name, score });
  });

  return scorers
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

/**
 * Build streakers leaderboard from player streaks
 * Sorted by streak descending, returns top N (only those with streak > 0)
 */
export function buildStreakersLeaderboard(
  players: Map<string, { name: string; streak: number }>,
  limit: number = 5
): Streaker[] {
  const streakers: Array<{ name: string; streak: number }> = [];

  players.forEach(({ name, streak }) => {
    if (streak > 0) {
      streakers.push({ name, streak });
    }
  });

  return streakers
    .sort((a, b) => b.streak - a.streak)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, name: p.name, streak: p.streak }));
}

/**
 * Calculate percentage of correct answers for a question
 */
export function calculateCorrectPercentage(
  correctCount: number,
  totalAnswers: number
): number {
  if (totalAnswers === 0) return 0;
  return Math.round((correctCount / totalAnswers) * 100);
}
