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

export const POINTS_PER_CORRECT = 10;

/**
 * Calculate score for a correct answer
 * Currently fixed at 10 points per correct answer
 */
export function calculateScore(isCorrect: boolean): number {
  return isCorrect ? POINTS_PER_CORRECT : 0;
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
