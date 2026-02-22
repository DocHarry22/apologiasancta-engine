/**
 * Player state management - answers, scores, and streaks
 */

import { calculateScoreDetails } from "../engine/scoring";

/** Answer submitted by a player */
export interface PlayerAnswer {
  choiceId: string;
  answerTimeMs: number;
}

/** Player data */
export interface Player {
  userId: string;
  name: string;
  score: number;
  streak: number;
}

/** In-memory player storage */
const players: Map<string, Player> = new Map();

/** Answers for current question: Map<questionIndex, Map<userId, answer>> */
const questionAnswers: Map<number, Map<string, PlayerAnswer>> = new Map();

/**
 * Get or create a player
 */
export function getOrCreatePlayer(userId: string, name: string): Player {
  let player = players.get(userId);
  if (!player) {
    player = { userId, name, score: 0, streak: 0 };
    players.set(userId, player);
    console.log(`[Players] New player: ${name} (${userId})`);
  } else if (player.name !== name) {
    // Update name if changed
    player.name = name;
  }
  return player;
}

/**
 * Submit an answer for a question
 * Returns true if accepted, false if already answered
 */
export function submitAnswer(
  questionIndex: number,
  userId: string,
  name: string,
  choiceId: string
): boolean {
  // Get or create answers map for this question
  let answers = questionAnswers.get(questionIndex);
  if (!answers) {
    answers = new Map();
    questionAnswers.set(questionIndex, answers);
  }

  // Check if already answered
  if (answers.has(userId)) {
    console.log(`[Players] Duplicate answer ignored: ${userId} for Q${questionIndex}`);
    return false;
  }

  // Ensure player exists
  getOrCreatePlayer(userId, name);

  // Store answer
  answers.set(userId, {
    choiceId,
    answerTimeMs: Date.now(),
  });

  console.log(`[Players] Answer accepted: ${name} chose ${choiceId} for Q${questionIndex}`);
  return true;
}

/**
 * Get all answers for a question
 */
export function getAnswersForQuestion(questionIndex: number): Map<string, PlayerAnswer> {
  return questionAnswers.get(questionIndex) || new Map();
}

/**
 * Evaluate answers and update scores/streaks
 */
export function evaluateAnswers(
  questionIndex: number,
  correctId: string,
  context: { openStartMs: number; openDurationMs: number; difficulty: number | "easy" | "medium" | "hard" }
): void {
  const answers = getAnswersForQuestion(questionIndex);
  
  // Track all players who participated in the quiz at any point
  const participatedUserIds = new Set(answers.keys());

  // Update scores and streaks for players who answered
  answers.forEach((answer, odUserId) => {
    const player = players.get(odUserId);
    if (!player) return;

    if (answer.choiceId === correctId) {
      const details = calculateScoreDetails({
        isCorrect: true,
        difficulty: context.difficulty,
        answerTimeMs: answer.answerTimeMs,
        openStartMs: context.openStartMs,
        openDurationMs: context.openDurationMs,
      });

      player.score += details.score;
      player.streak += 1;
      console.log(
        `[Scoring] ${player.name}: +${details.score} pts, streak ${player.streak} ` +
          `(mode=${details.mode}, difficulty=${details.difficulty}, f=${details.f.toFixed(3)}, ` +
          `multiplier=${details.multiplier.toFixed(3)}, finalPoints=${details.score})`
      );
    } else {
      // Wrong answer: reset streak
      player.streak = 0;
      console.log(`[Scoring] ${player.name}: wrong, streak reset`);
    }
  });

  // Reset streaks for players who didn't answer this question but have played before
  players.forEach((player, odUserId) => {
    if (!participatedUserIds.has(odUserId) && player.streak > 0) {
      console.log(`[Scoring] ${player.name}: no answer, streak reset from ${player.streak}`);
      player.streak = 0;
    }
  });
}

/**
 * Get top scorers (up to limit)
 */
export function getTopScorers(limit: number = 10): Array<{ rank: number; name: string; score: number }> {
  const sorted = Array.from(players.values())
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return sorted.map((p, i) => ({
    rank: i + 1,
    name: p.name,
    score: p.score,
  }));
}

/**
 * Get top streakers (up to limit)
 */
export function getTopStreaks(limit: number = 5): Array<{ rank: number; name: string; streak: number }> {
  const sorted = Array.from(players.values())
    .filter((p) => p.streak > 0)
    .sort((a, b) => b.streak - a.streak)
    .slice(0, limit);

  return sorted.map((p, i) => ({
    rank: i + 1,
    name: p.name,
    streak: p.streak,
  }));
}

/**
 * Clear answers for a specific question
 */
export function clearAnswersForQuestion(questionIndex: number): void {
  questionAnswers.delete(questionIndex);
}

/**
 * Reset all player data (scores, streaks, answers)
 */
export function resetAllPlayers(): void {
  players.clear();
  questionAnswers.clear();
  console.log("[Players] All player data reset");
}

/**
 * Get player count
 */
export function getPlayerCount(): number {
  return players.size;
}
