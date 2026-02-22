/**
 * Player state management - answers, scores, streaks, and identity
 */

import { randomUUID } from "crypto";
import { calculateScoreDetails } from "../engine/scoring";
import type { PlayerInfo } from "../types/quiz";

/** Answer submitted by a player */
export interface PlayerAnswer {
  choiceId: string;
  answerTimeMs: number;
}

/** Player data */
export interface Player {
  userId: string;
  username: string;
  usernameLower: string; // For case-insensitive lookups
  score: number;
  streak: number;
  registeredAt: number;
}

/** Registration result */
export interface RegisterResult {
  ok: boolean;
  userId?: string;
  username?: string;
  reason?: "invalid_username" | "username_taken" | "invalid_format";
  message?: string;
}

/** In-memory player storage by userId */
const players: Map<string, Player> = new Map();

/** Username -> userId mapping for uniqueness enforcement (case-insensitive) */
const usernameToUserId: Map<string, string> = new Map();

/** Answers for current question: Map<questionIndex, Map<userId, answer>> */
const questionAnswers: Map<number, Map<string, PlayerAnswer>> = new Map();

/** Username validation regex: 3-20 chars, alphanumeric + underscore */
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

/**
 * Normalize username for storage: trim, collapse spaces
 */
function normalizeUsername(raw: string): string {
  return raw.trim().replace(/\s+/g, "_").slice(0, 20);
}

/**
 * Validate username format
 */
export function isValidUsername(username: string): boolean {
  return USERNAME_REGEX.test(username);
}

/**
 * Register a new player with unique username
 */
export function registerPlayer(requestedUsername: string, providedUserId?: string): RegisterResult {
  const username = normalizeUsername(requestedUsername);
  const usernameLower = username.toLowerCase();
  
  // Validate format
  if (!isValidUsername(username)) {
    return {
      ok: false,
      reason: "invalid_format",
      message: "Username must be 3-20 characters, alphanumeric or underscore only",
    };
  }
  
  // Check uniqueness (case-insensitive)
  const existingUserId = usernameToUserId.get(usernameLower);
  if (existingUserId) {
    // If same userId is re-registering with same username, allow it (reconnect case)
    if (providedUserId && existingUserId === providedUserId) {
      const player = players.get(providedUserId)!;
      return { ok: true, userId: providedUserId, username: player.username };
    }
    // Username taken by different user
    return {
      ok: false,
      reason: "username_taken",
      message: `Username "${username}" is already taken`,
    };
  }
  
  // Generate or use provided userId
  const userId = providedUserId || randomUUID();
  
  // Check if this userId already has a different username
  const existingPlayer = players.get(userId);
  if (existingPlayer && existingPlayer.usernameLower !== usernameLower) {
    // Remove old username mapping
    usernameToUserId.delete(existingPlayer.usernameLower);
  }
  
  // Create or update player
  const player: Player = existingPlayer
    ? { ...existingPlayer, username, usernameLower }
    : {
        userId,
        username,
        usernameLower,
        score: 0,
        streak: 0,
        registeredAt: Date.now(),
      };
  
  players.set(userId, player);
  usernameToUserId.set(usernameLower, userId);
  
  console.log(`[Players] Registered: ${username} (${userId})`);
  return { ok: true, userId, username };
}

/**
 * Check if a userId is registered
 */
export function isRegistered(userId: string): boolean {
  return players.has(userId);
}

/**
 * Check if a username is taken (case-insensitive)
 */
export function isUsernameTaken(username: string): boolean {
  return usernameToUserId.has(username.toLowerCase());
}

/**
 * Get player by userId
 */
export function getPlayer(userId: string): Player | undefined {
  return players.get(userId);
}

/**
 * Extract last 4 characters of a channelId for disambiguation
 */
function getChannelIdSuffix(userId: string): string {
  // userId format: "yt:UCxxxxxx" -> take last 4 of the channel ID part
  const channelId = userId.startsWith("yt:") ? userId.slice(3) : userId;
  return channelId.slice(-4);
}

/**
 * Get or create a player (for YouTube auto-registration)
 * Uses userId = "yt:<channelId>" as the stable key.
 * 
 * Username collision handling:
 * 1. Try displayName as-is
 * 2. If taken, use displayName#last4 format immediately
 */
export function getOrCreatePlayer(userId: string, displayName: string): Player {
  let player = players.get(userId);
  
  if (player) {
    // Player already exists - optionally sync displayName changes for YouTube
    if (userId.startsWith("yt:")) {
      const normalizedNew = normalizeUsername(displayName);
      // Only update if YouTube display name changed and new name is available
      if (player.username !== normalizedNew && player.usernameLower !== normalizedNew.toLowerCase()) {
        const newLower = normalizedNew.toLowerCase();
        const existingOwner = usernameToUserId.get(newLower);
        if (!existingOwner) {
          // New displayName is available, update it
          usernameToUserId.delete(player.usernameLower);
          player.username = normalizedNew;
          player.usernameLower = newLower;
          usernameToUserId.set(newLower, userId);
          console.log(`[Players] YouTube displayName updated: ${player.username} (${userId})`);
        }
        // If taken by someone else, keep old username
      }
    }
    return player;
  }
  
  // New player - register with collision handling
  const result = registerPlayer(displayName, userId);
  if (result.ok) {
    player = players.get(userId)!;
  } else {
    // Username collision - use #last4 format immediately (more readable than _2)
    const suffix = getChannelIdSuffix(userId);
    const disambiguated = `${normalizeUsername(displayName).slice(0, 15)}#${suffix}`;
    const altResult = registerPlayer(disambiguated, userId);
    if (altResult.ok) {
      player = players.get(userId)!;
      console.log(`[Players] YouTube collision resolved: ${displayName} -> ${player.username}`);
    } else {
      // Extremely rare: even #suffix is taken, use full fallback
      const fallbackName = `yt_${suffix}_${Date.now() % 10000}`;
      registerPlayer(fallbackName, userId);
      player = players.get(userId)!;
      console.log(`[Players] YouTube fallback name: ${displayName} -> ${player.username}`);
    }
  }
  
  return player;
}

/**
 * Submit an answer for a question
 * Returns true if accepted, false if already answered
 */
/**
 * Submit answer for a registered player
 * Returns { accepted: true } or { accepted: false, reason: string }
 */
export function submitAnswerForRegistered(
  questionIndex: number,
  userId: string,
  choiceId: string
): { accepted: boolean; reason?: string } {
  // Check registration
  const player = players.get(userId);
  if (!player) {
    return { accepted: false, reason: "not_registered" };
  }

  // Get or create answers map for this question
  let answers = questionAnswers.get(questionIndex);
  if (!answers) {
    answers = new Map();
    questionAnswers.set(questionIndex, answers);
  }

  // Check if already answered
  if (answers.has(userId)) {
    console.log(`[Players] Duplicate answer ignored: ${userId} for Q${questionIndex}`);
    return { accepted: false, reason: "already_answered" };
  }

  // Store answer
  const normalizedChoiceId = choiceId.toLowerCase();
  answers.set(userId, {
    choiceId: normalizedChoiceId,
    answerTimeMs: Date.now(),
  });

  console.log(`[Players] Answer accepted: ${player.username} chose ${normalizedChoiceId} for Q${questionIndex}`);
  return { accepted: true };
}

/**
 * Legacy submitAnswer - for YouTube auto-registration compatibility
 */
export function submitAnswer(
  questionIndex: number,
  userId: string,
  name: string,
  choiceId: string
): boolean {
  // Auto-register for YouTube players
  getOrCreatePlayer(userId, name);
  const result = submitAnswerForRegistered(questionIndex, userId, choiceId);
  return result.accepted;
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
  const normalizedCorrectId = correctId.toLowerCase();
  
  // Track all players who participated in the quiz at any point
  const participatedUserIds = new Set(answers.keys());

  // Update scores and streaks for players who answered
  answers.forEach((answer, odUserId) => {
    const player = players.get(odUserId);
    if (!player) return;

    const isCorrect = answer.choiceId.toLowerCase() === normalizedCorrectId;
    
    // Record for topic statistics
    recordAnswerResult(odUserId, isCorrect);

    if (isCorrect) {
      const details = calculateScoreDetails({
        isCorrect: true,
        difficulty: context.difficulty,
        answerTimeMs: answer.answerTimeMs,
        openStartMs: context.openStartMs,
        openDurationMs: context.openDurationMs,
        currentStreak: player.streak,
      });

      player.score += details.score;
      player.streak += 1;
      console.log(
        `[Scoring] ${player.username}: +${details.score} pts, streak ${player.streak} ` +
          `(mode=${details.mode}, difficulty=${details.difficulty}, f=${details.f.toFixed(3)}, ` +
          `timeMult=${details.timeMultiplier.toFixed(2)}, streakBonus=${details.streakBonus})`
      );
    } else {
      // Wrong answer: reset streak
      player.streak = 0;
      console.log(`[Scoring] ${player.username}: wrong, streak reset`);
    }
  });

  // Reset streaks for players who didn't answer this question but have played before
  players.forEach((player, odUserId) => {
    if (!participatedUserIds.has(odUserId) && player.streak > 0) {
      console.log(`[Scoring] ${player.username}: no answer, streak reset from ${player.streak}`);
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
    name: p.username,
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
    name: p.username,
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
 * Clear all pending answers across all question indexes.
 * Useful when replacing the active question pool.
 */
export function clearAllAnswers(): void {
  questionAnswers.clear();
}

/**
 * Reset all player data (scores, streaks, answers)
 * Note: Also clears username mappings
 */
export function resetAllPlayers(): void {
  players.clear();
  usernameToUserId.clear();
  questionAnswers.clear();
  console.log("[Players] All player data reset");
}

/**
 * Get player count
 */
export function getPlayerCount(): number {
  return players.size;
}

/**
 * Get player's rank in the scoreboard
 * Returns undefined if player has no score
 */
export function getPlayerRank(userId: string): number | undefined {
  const player = players.get(userId);
  if (!player || player.score === 0) return undefined;
  
  const sorted = Array.from(players.values())
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
  
  const index = sorted.findIndex((p) => p.userId === userId);
  return index >= 0 ? index + 1 : undefined;
}

/**
 * Get distance to 10th place (points needed to enter top 10)
 */
export function getDistanceToTop10(userId: string): number | undefined {
  const player = players.get(userId);
  if (!player) return undefined;
  
  const sorted = Array.from(players.values())
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
  
  // If less than 10 players, no distance needed
  if (sorted.length < 10) return 0;
  
  const rank = sorted.findIndex((p) => p.userId === userId);
  if (rank >= 0 && rank < 10) return 0; // Already in top 10
  
  const tenthPlace = sorted[9];
  return Math.max(0, tenthPlace.score - player.score + 1);
}

/**
 * Get full player info for personalized SSE
 */
export function getPlayerInfo(userId: string): PlayerInfo | undefined {
  const player = players.get(userId);
  if (!player) return undefined;
  
  return {
    userId: player.userId,
    username: player.username,
    totalPoints: player.score,
    streak: player.streak,
    rank: getPlayerRank(userId),
    distanceToTop10: getDistanceToTop10(userId),
  };
}

// ============== Topic Summary Statistics ==============

/** Track correct/total answers per player for stats calculation */
const playerCorrectCounts: Map<string, { correct: number; total: number }> = new Map();

/**
 * Record a player's answer result for statistics
 * Called during evaluateAnswers
 */
export function recordAnswerResult(userId: string, isCorrect: boolean): void {
  const counts = playerCorrectCounts.get(userId) || { correct: 0, total: 0 };
  counts.total += 1;
  if (isCorrect) {
    counts.correct += 1;
  }
  playerCorrectCounts.set(userId, counts);
}

/**
 * Clear player answer statistics (called on topic/series reset)
 */
export function clearPlayerStats(): void {
  playerCorrectCounts.clear();
}

/**
 * Get top scorers with streak info for topic summary
 */
export function getTopScorersWithStreaks(limit: number = 10): Array<{
  rank: number;
  name: string;
  score: number;
  streak: number;
}> {
  const sorted = Array.from(players.values())
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return sorted.map((p, i) => ({
    rank: i + 1,
    name: p.username,
    score: p.score,
    streak: p.streak,
  }));
}

/**
 * Get top streaks with scores for topic summary
 */
export function getTopStreaksWithScores(limit: number = 5): Array<{
  rank: number;
  name: string;
  streak: number;
  score: number;
}> {
  const sorted = Array.from(players.values())
    .filter((p) => p.streak > 0)
    .sort((a, b) => b.streak - a.streak)
    .slice(0, limit);

  return sorted.map((p, i) => ({
    rank: i + 1,
    name: p.username,
    streak: p.streak,
    score: p.score,
  }));
}

/**
 * Get topic summary statistics
 */
export function getTopicStats(): {
  averageCorrectPct: number;
  totalParticipants: number;
  maxScore: number;
} {
  const participants = Array.from(players.values()).filter(
    (p) => playerCorrectCounts.has(p.userId) || p.score > 0
  );
  
  if (participants.length === 0) {
    return {
      averageCorrectPct: 0,
      totalParticipants: 0,
      maxScore: 0,
    };
  }

  // Calculate average correct percentage
  let totalCorrectPct = 0;
  let playersWithAnswers = 0;
  
  for (const player of participants) {
    const counts = playerCorrectCounts.get(player.userId);
    if (counts && counts.total > 0) {
      totalCorrectPct += (counts.correct / counts.total) * 100;
      playersWithAnswers++;
    }
  }

  const averageCorrectPct = playersWithAnswers > 0
    ? Math.round(totalCorrectPct / playersWithAnswers)
    : 0;

  const maxScore = Math.max(0, ...participants.map((p) => p.score));

  return {
    averageCorrectPct,
    totalParticipants: participants.length,
    maxScore,
  };
}

/**
 * Reset scores and streaks but preserve player registrations
 * Used for topic transitions
 */
export function resetScoresAndStreaks(): void {
  players.forEach((player) => {
    player.score = 0;
    player.streak = 0;
  });
  playerCorrectCounts.clear();
  questionAnswers.clear();
  console.log("[Players] Scores and streaks reset (registrations preserved)");
}
