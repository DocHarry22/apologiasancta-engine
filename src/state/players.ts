/**
 * Player state management - answers, scores, streaks, and identity.
 *
 * Player identity is global.
 * Scores, streaks, answers, and topic stats are room-scoped.
 */

import { randomUUID } from "crypto";
import { calculateScoreDetails } from "../engine/scoring";
import { DEFAULT_ROOM_ID, getRoomName } from "./rooms";
import { schedulePersistence, type PersistenceMutation } from "./persistence";
import type { Leaderboard, LeaderboardPeriod, PlayerInfo } from "../types/quiz";
import { isValidPublicDisplayName, normalizePublicDisplayName } from "../security/publicDisplayName";

export interface PlayerAnswer {
  choiceId: string;
  answerTimeMs: number;
}

export interface Player {
  userId: string;
  username: string;
  usernameLower: string;
  registeredAt: number;
}

export interface AccountIdentityMapping {
  issuer: string;
  subject: string;
  userId: string;
  createdAt: number;
  lastExchangedAt: number;
}

export const ACCOUNT_DISPLAY_NAME_MANAGED_REASON = "account_display_name_managed";

export interface RegisterResult {
  ok: boolean;
  userId?: string;
  username?: string;
  reason?: "invalid_username" | "username_taken" | "invalid_format" | typeof ACCOUNT_DISPLAY_NAME_MANAGED_REASON;
  message?: string;
}

interface PlayerRoomState {
  score: number;
  streak: number;
}

interface TopicAnswerCounts {
  correct: number;
  total: number;
}

interface ScoreEvent {
  userId: string;
  points: number;
  streak: number;
  atMs: number;
}

interface RoomPlayerState {
  playerStates: Map<string, PlayerRoomState>;
  questionAnswers: Map<number, Map<string, PlayerAnswer>>;
  playerCorrectCounts: Map<string, TopicAnswerCounts>;
  scoreEvents: ScoreEvent[];
}

export interface PersistedPlayersSnapshot {
  players: Player[];
  /** Added in July 2026; optional so pre-identity snapshots restore unchanged. */
  accountIdentities?: AccountIdentityMapping[];
  roomStates: Array<{
    roomId: string;
    playerStates: Array<{ userId: string; score: number; streak: number }>;
    playerCorrectCounts: Array<{ userId: string; correct: number; total: number }>;
    scoreEvents: ScoreEvent[];
  }>;
}

const players: Map<string, Player> = new Map();
const usernameToUserId: Map<string, string> = new Map();
const accountIdentities: Map<string, AccountIdentityMapping> = new Map();
const accountLinkedUserIds: Set<string> = new Set();
const roomStates: Map<string, RoomPlayerState> = new Map();

function accountIdentityKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

function getRoomState(roomId: string): RoomPlayerState {
  let roomState = roomStates.get(roomId);
  if (!roomState) {
    roomState = {
      playerStates: new Map(),
      questionAnswers: new Map(),
      playerCorrectCounts: new Map(),
      scoreEvents: [],
    };
    roomStates.set(roomId, roomState);
  }
  return roomState;
}

function getOrCreatePlayerRoomState(roomId: string, userId: string): PlayerRoomState {
  const roomState = getRoomState(roomId);
  let playerState = roomState.playerStates.get(userId);
  if (!playerState) {
    playerState = { score: 0, streak: 0 };
    roomState.playerStates.set(userId, playerState);
  }
  return playerState;
}

function getPlayerRoomState(roomId: string, userId: string): PlayerRoomState | undefined {
  return roomStates.get(roomId)?.playerStates.get(userId);
}

function getScoreboardEntries(roomId: string): Array<{
  userId: string;
  username: string;
  usernameLower: string;
  score: number;
  streak: number;
}> {
  return Array.from(getRoomState(roomId).playerStates.entries())
    .map(([userId, roomState]) => {
      const player = players.get(userId);
      if (!player) {
        return undefined;
      }

      return {
        userId,
        username: player.username,
        usernameLower: player.usernameLower,
        score: roomState.score,
        streak: roomState.streak,
      };
    })
    .filter((entry): entry is {
      userId: string;
      username: string;
      usernameLower: string;
      score: number;
      streak: number;
    } => Boolean(entry));
}

function sortByScore(roomId: string) {
  return getScoreboardEntries(roomId).sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.usernameLower.localeCompare(right.usernameLower);
  });
}

function sortByStreak(roomId: string) {
  return getScoreboardEntries(roomId).sort((left, right) => {
    if (right.streak !== left.streak) {
      return right.streak - left.streak;
    }
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.usernameLower.localeCompare(right.usernameLower);
  });
}

function getPeriodStart(period: LeaderboardPeriod, nowMs: number): number {
  if (period === "all-time") {
    return 0;
  }

  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);

  if (period === "daily") {
    return date.getTime();
  }

  const dayOfWeek = date.getDay();
  date.setDate(date.getDate() - dayOfWeek);
  return date.getTime();
}

function getScoreEventsForScope(roomId?: string): ScoreEvent[] {
  if (roomId) {
    return getRoomState(roomId).scoreEvents;
  }

  return [...roomStates.values()].flatMap((roomState) => roomState.scoreEvents);
}

export function getLeaderboardForPeriod(
  period: LeaderboardPeriod,
  options: { roomId?: string; limit?: number } = {}
): Leaderboard {
  const { roomId, limit = 10 } = options;
  const nowMs = Date.now();
  const periodStart = getPeriodStart(period, nowMs);
  const roomName = roomId ? getRoomName(roomId) : undefined;
  const relevantEvents = getScoreEventsForScope(roomId).filter((event) => event.atMs >= periodStart);
  const aggregates = new Map<string, { score: number; maxStreak: number }>();

  for (const event of relevantEvents) {
    const current = aggregates.get(event.userId) || { score: 0, maxStreak: 0 };
    current.score += event.points;
    current.maxStreak = Math.max(current.maxStreak, event.streak);
    aggregates.set(event.userId, current);
  }

  const entries = [...aggregates.entries()]
    .map(([userId, aggregate]) => {
      const player = players.get(userId);
      if (!player) {
        return undefined;
      }

      return {
        username: player.username,
        usernameLower: player.usernameLower,
        score: aggregate.score,
        streak: aggregate.maxStreak,
      };
    })
    .filter((entry): entry is { username: string; usernameLower: string; score: number; streak: number } => Boolean(entry));

  const byScore = [...entries]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.usernameLower.localeCompare(right.usernameLower);
    })
    .slice(0, limit);

  const byStreak = [...entries]
    .filter((entry) => entry.streak > 0)
    .sort((left, right) => {
      if (right.streak !== left.streak) {
        return right.streak - left.streak;
      }
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.usernameLower.localeCompare(right.usernameLower);
    })
    .slice(0, Math.min(5, limit));

  return {
    topScorers: byScore.map((entry, index) => ({
      rank: index + 1,
      name: entry.username,
      score: entry.score,
    })),
    topStreaks: byStreak.map((entry, index) => ({
      rank: index + 1,
      name: entry.username,
      streak: entry.streak,
    })),
    scope: roomId ? "room" : "global",
    period,
    roomId,
    roomName,
    snapshotAtMs: nowMs,
  };
}

export function isValidUsername(username: string): boolean {
  return isValidPublicDisplayName(username);
}

function registerPlayerWithAuthority(
  requestedUsername: string,
  providedUserId?: string,
  allowAccountDisplayNameChange = false
): RegisterResult {
  const username = normalizePublicDisplayName(requestedUsername);
  const usernameLower = username.toLowerCase();

  if (!isValidUsername(username)) {
    return {
      ok: false,
      reason: "invalid_format",
      message: "Username must be 3-20 characters, alphanumeric or underscore only",
    };
  }

  const existingPlayer = providedUserId ? players.get(providedUserId) : undefined;
  if (
    existingPlayer
    && accountLinkedUserIds.has(existingPlayer.userId)
    && existingPlayer.username !== username
    && !allowAccountDisplayNameChange
  ) {
    return {
      ok: false,
      reason: ACCOUNT_DISPLAY_NAME_MANAGED_REASON,
      message: "Account-linked display names can only be changed through /identity/exchange",
    };
  }

  const existingUserId = usernameToUserId.get(usernameLower);
  if (existingUserId) {
    if (providedUserId && existingUserId === providedUserId) {
      const player = players.get(providedUserId)!;
      if (allowAccountDisplayNameChange && player.username !== username) {
        const updatedPlayer = { ...player, username, usernameLower };
        players.set(providedUserId, updatedPlayer);
        schedulePersistence();
        console.log(`[Players] Registered: ${username} (${providedUserId})`);
        return { ok: true, userId: providedUserId, username };
      }
      return { ok: true, userId: providedUserId, username: player.username };
    }

    return {
      ok: false,
      reason: "username_taken",
      message: `Username "${username}" is already taken`,
    };
  }

  const userId = providedUserId || randomUUID();
  const currentPlayer = existingPlayer ?? players.get(userId);
  if (currentPlayer && currentPlayer.usernameLower !== usernameLower) {
    usernameToUserId.delete(currentPlayer.usernameLower);
  }

  const player: Player = currentPlayer
    ? { ...currentPlayer, username, usernameLower }
    : {
        userId,
        username,
        usernameLower,
        registeredAt: Date.now(),
      };

  players.set(userId, player);
  usernameToUserId.set(usernameLower, userId);
  schedulePersistence();

  console.log(`[Players] Registered: ${username} (${userId})`);
  return { ok: true, userId, username };
}

/** Guest/player-session registration never has authority to rename an account identity. */
export function registerPlayer(requestedUsername: string, providedUserId?: string): RegisterResult {
  return registerPlayerWithAuthority(requestedUsername, providedUserId);
}

export function isRegistered(userId: string): boolean {
  return players.has(userId);
}

export function isUsernameTaken(username: string): boolean {
  return usernameToUserId.has(username.toLowerCase());
}

export function getPlayer(userId: string): Player | undefined {
  return players.get(userId);
}

export interface ResolveAccountPlayerResult extends RegisterResult {
  identityCreated?: boolean;
  displayNameAdjusted?: boolean;
}

function accountCollisionFallback(displayName: string, userId: string): string {
  const suffix = userId.replace(/[^a-zA-Z0-9]/g, "").slice(-6);
  return `${displayName.slice(0, 13)}_${suffix}`;
}

/**
 * Resolve an account authority's opaque subject to an Engine-owned opaque ID.
 * The external subject never becomes a public player ID or leaderboard field.
 */
function resolveAccountPlayer(
  issuer: string,
  subject: string,
  requestedDisplayName: string,
  nowMs = Date.now()
): ResolveAccountPlayerResult {
  const key = accountIdentityKey(issuer, subject);
  const existingMapping = accountIdentities.get(key);

  if (existingMapping) {
    const existingPlayer = players.get(existingMapping.userId);
    // Trusted account-resolution path; its HTTP caller verifies the backend assertion first.
    const update = registerPlayerWithAuthority(requestedDisplayName, existingMapping.userId, true);
    existingMapping.lastExchangedAt = nowMs;
    schedulePersistence();

    if (!update.ok && update.reason === "username_taken" && existingPlayer) {
      return {
        ok: true,
        userId: existingPlayer.userId,
        username: existingPlayer.username,
        identityCreated: false,
        displayNameAdjusted: true,
      };
    }
    return { ...update, identityCreated: false, displayNameAdjusted: false };
  }

  const userId = `acct_${randomUUID()}`;
  let registration = registerPlayer(requestedDisplayName, userId);
  let displayNameAdjusted = false;
  if (!registration.ok && registration.reason === "username_taken") {
    registration = registerPlayer(accountCollisionFallback(requestedDisplayName, userId), userId);
    displayNameAdjusted = registration.ok;
  }
  if (!registration.ok || !registration.userId || !registration.username) return registration;

  accountIdentities.set(key, {
    issuer,
    subject,
    userId,
    createdAt: nowMs,
    lastExchangedAt: nowMs,
  });
  accountLinkedUserIds.add(userId);
  schedulePersistence();
  console.log(`[Players] Account identity linked: issuer=${issuer} userId=${userId}`);
  return { ...registration, identityCreated: true, displayNameAdjusted };
}

function accountIdentityReferencesUser(userId: string): boolean {
  return [...accountIdentities.values()].some((mapping) => mapping.userId === userId);
}

/**
 * Apply account resolution with an identity-scoped undo record. Rollback uses
 * object identity checks so a concurrent mutation of the same player is never
 * overwritten, and it never restores the full player collection.
 */
export function beginAccountPlayerResolution(
  issuer: string,
  subject: string,
  requestedDisplayName: string,
  nowMs = Date.now()
): PersistenceMutation<ResolveAccountPlayerResult> {
  const key = accountIdentityKey(issuer, subject);
  const previousMapping = accountIdentities.get(key);
  const previousMappingSnapshot = previousMapping ? { ...previousMapping } : undefined;
  const previousUserId = previousMapping?.userId;
  const previousPlayer = previousUserId ? players.get(previousUserId) : undefined;
  const previousWasLinked = previousUserId ? accountLinkedUserIds.has(previousUserId) : false;

  const result = resolveAccountPlayer(issuer, subject, requestedDisplayName, nowMs);
  const appliedUserId = result.userId;
  const appliedPlayer = appliedUserId ? players.get(appliedUserId) : undefined;
  const appliedMapping = accountIdentities.get(key);
  let previousNameReserved = false;
  if (
    appliedUserId
    && previousPlayer
    && appliedPlayer
    && previousPlayer.usernameLower !== appliedPlayer.usernameLower
    && usernameToUserId.get(previousPlayer.usernameLower) === undefined
  ) {
    // registerPlayer releases the old canonical name synchronously. Hold it as
    // a process-local alias until the persistence decision so a guest cannot
    // claim it while rollback may still need to restore the account.
    usernameToUserId.set(previousPlayer.usernameLower, appliedUserId);
    previousNameReserved = true;
  }

  return {
    value: result,
    commit: () => {
      if (!previousNameReserved || !appliedUserId || !previousPlayer) return;
      const currentPlayer = players.get(appliedUserId);
      if (
        currentPlayer?.usernameLower !== previousPlayer.usernameLower
        && usernameToUserId.get(previousPlayer.usernameLower) === appliedUserId
      ) {
        usernameToUserId.delete(previousPlayer.usernameLower);
      }
    },
    rollback: () => {
      let changed = false;

      if (appliedUserId && appliedPlayer && players.get(appliedUserId) === appliedPlayer) {
        const previousNameOwner = previousPlayer
          ? usernameToUserId.get(previousPlayer.usernameLower)
          : undefined;
        if (!previousPlayer || !previousNameOwner || previousNameOwner === appliedUserId) {
          if (usernameToUserId.get(appliedPlayer.usernameLower) === appliedUserId) {
            usernameToUserId.delete(appliedPlayer.usernameLower);
          }
          if (previousPlayer) {
            players.set(appliedUserId, previousPlayer);
            usernameToUserId.set(previousPlayer.usernameLower, appliedUserId);
          } else {
            players.delete(appliedUserId);
          }
          changed = true;
        }
      }

      let mappingRolledBack = false;
      if (appliedMapping && accountIdentities.get(key) === appliedMapping) {
        if (previousMappingSnapshot) accountIdentities.set(key, previousMappingSnapshot);
        else accountIdentities.delete(key);
        mappingRolledBack = true;
        changed = true;
      }

      if (appliedUserId && mappingRolledBack) {
        if (previousWasLinked) accountLinkedUserIds.add(appliedUserId);
        else if (!accountIdentityReferencesUser(appliedUserId)) accountLinkedUserIds.delete(appliedUserId);
      }

      if (previousNameReserved && appliedUserId && previousPlayer) {
        const currentPlayer = players.get(appliedUserId);
        if (currentPlayer?.usernameLower === previousPlayer.usernameLower) {
          usernameToUserId.set(previousPlayer.usernameLower, appliedUserId);
        } else if (usernameToUserId.get(previousPlayer.usernameLower) === appliedUserId) {
          usernameToUserId.delete(previousPlayer.usernameLower);
        }
      }

      if (changed) schedulePersistence();
    },
  };
}

export function getAccountIdentityMapping(issuer: string, subject: string): AccountIdentityMapping | undefined {
  const mapping = accountIdentities.get(accountIdentityKey(issuer, subject));
  return mapping ? { ...mapping } : undefined;
}

export function isAccountLinkedPlayer(userId: string): boolean {
  return accountLinkedUserIds.has(userId);
}

function getChannelIdSuffix(userId: string): string {
  const channelId = userId.startsWith("yt:") ? userId.slice(3) : userId;
  return channelId.slice(-4);
}

export function getOrCreatePlayer(userId: string, displayName: string): Player {
  let player = players.get(userId);

  if (player) {
    if (userId.startsWith("yt:") && !accountLinkedUserIds.has(userId)) {
      const normalizedNew = normalizePublicDisplayName(displayName);
      if (player.username !== normalizedNew && player.usernameLower !== normalizedNew.toLowerCase()) {
        const newLower = normalizedNew.toLowerCase();
        const existingOwner = usernameToUserId.get(newLower);
        if (!existingOwner) {
          usernameToUserId.delete(player.usernameLower);
          player.username = normalizedNew;
          player.usernameLower = newLower;
          usernameToUserId.set(newLower, userId);
          console.log(`[Players] YouTube displayName updated: ${player.username} (${userId})`);
        }
      }
    }
    return player;
  }

  const result = registerPlayer(displayName, userId);
  if (result.ok) {
    return players.get(userId)!;
  }

  const suffix = getChannelIdSuffix(userId);
  const disambiguated = `${normalizePublicDisplayName(displayName).slice(0, 15)}#${suffix}`;
  const altResult = registerPlayer(disambiguated, userId);
  if (altResult.ok) {
    player = players.get(userId)!;
    console.log(`[Players] YouTube collision resolved: ${displayName} -> ${player.username}`);
    return player;
  }

  const fallbackName = `yt_${suffix}_${Date.now() % 10000}`;
  registerPlayer(fallbackName, userId);
  player = players.get(userId)!;
  console.log(`[Players] YouTube fallback name: ${displayName} -> ${player.username}`);
  return player;
}

export function initializePlayerRoom(userId: string, roomId: string = DEFAULT_ROOM_ID): void {
  if (!players.has(userId)) {
    return;
  }
  getOrCreatePlayerRoomState(roomId, userId);
}

export function beginPlayerRoomInitialization(
  userId: string,
  roomId: string = DEFAULT_ROOM_ID
): PersistenceMutation<void> {
  const previousRoomState = roomStates.get(roomId);
  const previousPlayerState = previousRoomState?.playerStates.get(userId);
  initializePlayerRoom(userId, roomId);
  const appliedRoomState = roomStates.get(roomId);
  const appliedPlayerState = appliedRoomState?.playerStates.get(userId);

  return {
    value: undefined,
    rollback: () => {
      if (previousPlayerState || !appliedRoomState || !appliedPlayerState) return;
      const currentRoomState = roomStates.get(roomId);
      if (currentRoomState !== appliedRoomState || currentRoomState.playerStates.get(userId) !== appliedPlayerState) return;
      if (appliedPlayerState.score !== 0 || appliedPlayerState.streak !== 0) return;

      currentRoomState.playerStates.delete(userId);
      if (
        !previousRoomState
        && currentRoomState.playerStates.size === 0
        && currentRoomState.questionAnswers.size === 0
        && currentRoomState.playerCorrectCounts.size === 0
        && currentRoomState.scoreEvents.length === 0
      ) {
        roomStates.delete(roomId);
      }
      schedulePersistence();
    },
  };
}

export function submitAnswerForRegistered(
  questionIndex: number,
  userId: string,
  choiceId: string,
  roomId: string = DEFAULT_ROOM_ID
): { accepted: boolean; reason?: string } {
  const player = players.get(userId);
  if (!player) {
    return { accepted: false, reason: "not_registered" };
  }

  initializePlayerRoom(userId, roomId);
  const roomState = getRoomState(roomId);

  let answers = roomState.questionAnswers.get(questionIndex);
  if (!answers) {
    answers = new Map();
    roomState.questionAnswers.set(questionIndex, answers);
  }

  if (answers.has(userId)) {
    console.log(`[Players] Duplicate answer ignored: ${userId} for room=${roomId} Q${questionIndex}`);
    return { accepted: false, reason: "already_answered" };
  }

  const normalizedChoiceId = choiceId.toLowerCase();
  answers.set(userId, {
    choiceId: normalizedChoiceId,
    answerTimeMs: Date.now(),
  });

  console.log(`[Players] Answer accepted: ${player.username} chose ${normalizedChoiceId} for room=${roomId} Q${questionIndex}`);
  return { accepted: true };
}

export function submitAnswer(
  questionIndex: number,
  userId: string,
  name: string,
  choiceId: string,
  roomId: string = DEFAULT_ROOM_ID
): boolean {
  getOrCreatePlayer(userId, name);
  const result = submitAnswerForRegistered(questionIndex, userId, choiceId, roomId);
  return result.accepted;
}

export function getAnswersForQuestion(questionIndex: number, roomId: string = DEFAULT_ROOM_ID): Map<string, PlayerAnswer> {
  return getRoomState(roomId).questionAnswers.get(questionIndex) || new Map();
}

export function evaluateAnswers(
  questionIndex: number,
  correctId: string,
  context: { openStartMs: number; openDurationMs: number; difficulty: number | "easy" | "medium" | "hard" },
  roomId: string = DEFAULT_ROOM_ID
): void {
  const roomState = getRoomState(roomId);
  const answers = getAnswersForQuestion(questionIndex, roomId);
  const normalizedCorrectId = correctId.toLowerCase();
  const participatedUserIds = new Set(answers.keys());
  let stateChanged = false;

  answers.forEach((answer, answeredUserId) => {
    const player = players.get(answeredUserId);
    if (!player) {
      return;
    }

    const playerState = getOrCreatePlayerRoomState(roomId, answeredUserId);
    const isCorrect = answer.choiceId.toLowerCase() === normalizedCorrectId;
    recordAnswerResult(answeredUserId, isCorrect, roomId);

    if (isCorrect) {
      const details = calculateScoreDetails({
        isCorrect: true,
        difficulty: context.difficulty,
        answerTimeMs: answer.answerTimeMs,
        openStartMs: context.openStartMs,
        openDurationMs: context.openDurationMs,
        currentStreak: playerState.streak,
      });

      playerState.score += details.score;
      playerState.streak += 1;
      roomState.scoreEvents.push({
        userId: answeredUserId,
        points: details.score,
        streak: playerState.streak,
        atMs: Date.now(),
      });
      // Prune events older than 8 days to bound memory usage while keeping
      // enough history for daily/weekly leaderboard windows.
      const pruneBeforeMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const firstKeptIdx = roomState.scoreEvents.findIndex((ev) => ev.atMs >= pruneBeforeMs);
      if (firstKeptIdx > 0) {
        // Partial prune: remove stale entries at the front
        roomState.scoreEvents.splice(0, firstKeptIdx);
      } else if (firstKeptIdx === -1) {
        // All events are beyond the retention window — clear entirely
        roomState.scoreEvents.length = 0;
      }
      stateChanged = true;
      console.log(
        `[Scoring] [${roomId}] ${player.username}: +${details.score} pts, streak ${playerState.streak} ` +
          `(mode=${details.mode}, difficulty=${details.difficulty}, f=${details.f.toFixed(3)}, ` +
          `timeMult=${details.timeMultiplier.toFixed(2)}, streakBonus=${details.streakBonus})`
      );
    } else {
      playerState.streak = 0;
      stateChanged = true;
      console.log(`[Scoring] [${roomId}] ${player.username}: wrong, streak reset`);
    }
  });

  roomState.playerStates.forEach((playerState, checkedUserId) => {
    const player = players.get(checkedUserId);
    if (!player) {
      return;
    }

    if (!participatedUserIds.has(checkedUserId) && playerState.streak > 0) {
      console.log(`[Scoring] [${roomId}] ${player.username}: no answer, streak reset from ${playerState.streak}`);
      playerState.streak = 0;
      stateChanged = true;
    }
  });

  if (stateChanged) {
    schedulePersistence();
  }
}

export function getTopScorers(limit: number = 10, roomId: string = DEFAULT_ROOM_ID): Array<{ rank: number; name: string; score: number }> {
  return sortByScore(roomId)
    .filter((entry) => entry.score > 0)
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      name: entry.username,
      score: entry.score,
    }));
}

export function getTopStreaks(limit: number = 5, roomId: string = DEFAULT_ROOM_ID): Array<{ rank: number; name: string; streak: number }> {
  return sortByStreak(roomId)
    .filter((entry) => entry.streak > 0)
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      name: entry.username,
      streak: entry.streak,
    }));
}

export function clearAnswersForQuestion(questionIndex: number, roomId: string = DEFAULT_ROOM_ID): void {
  getRoomState(roomId).questionAnswers.delete(questionIndex);
}

export function clearAllAnswers(roomId?: string): void {
  if (roomId) {
    getRoomState(roomId).questionAnswers.clear();
    return;
  }

  roomStates.forEach((roomState) => {
    roomState.questionAnswers.clear();
  });
}

export function resetAllPlayers(): void {
  players.clear();
  usernameToUserId.clear();
  accountIdentities.clear();
  accountLinkedUserIds.clear();
  roomStates.clear();
  schedulePersistence();
  console.log("[Players] All player data reset");
}

export function getPlayerCount(roomId?: string): number {
  if (!roomId) {
    return players.size;
  }
  return getRoomState(roomId).playerStates.size;
}

export function getPlayerRank(userId: string, roomId: string = DEFAULT_ROOM_ID): number | undefined {
  const playerState = getPlayerRoomState(roomId, userId);
  if (!playerState || playerState.score === 0) {
    return undefined;
  }

  const index = sortByScore(roomId)
    .filter((entry) => entry.score > 0)
    .findIndex((entry) => entry.userId === userId);

  return index >= 0 ? index + 1 : undefined;
}

export function getDistanceToTop10(userId: string, roomId: string = DEFAULT_ROOM_ID): number | undefined {
  const playerState = getPlayerRoomState(roomId, userId);
  if (!playerState) {
    return undefined;
  }

  const sorted = sortByScore(roomId).filter((entry) => entry.score > 0);
  if (sorted.length < 10) {
    return 0;
  }

  const rank = sorted.findIndex((entry) => entry.userId === userId);
  if (rank >= 0 && rank < 10) {
    return 0;
  }

  return Math.max(0, sorted[9]!.score - playerState.score + 1);
}

export function getPlayerInfo(userId: string, roomId: string = DEFAULT_ROOM_ID): PlayerInfo | undefined {
  const player = players.get(userId);
  if (!player) {
    return undefined;
  }

  const playerState = getPlayerRoomState(roomId, userId);
  return {
    userId: player.userId,
    username: player.username,
    totalPoints: playerState?.score ?? 0,
    streak: playerState?.streak ?? 0,
    rank: getPlayerRank(userId, roomId),
    distanceToTop10: getDistanceToTop10(userId, roomId),
    roomId,
  };
}

export function recordAnswerResult(userId: string, isCorrect: boolean, roomId: string = DEFAULT_ROOM_ID): void {
  const roomState = getRoomState(roomId);
  const counts = roomState.playerCorrectCounts.get(userId) || { correct: 0, total: 0 };
  counts.total += 1;
  if (isCorrect) {
    counts.correct += 1;
  }
  roomState.playerCorrectCounts.set(userId, counts);
}

export function clearPlayerStats(roomId: string = DEFAULT_ROOM_ID): void {
  getRoomState(roomId).playerCorrectCounts.clear();
  schedulePersistence();
}

export function getTopScorersWithStreaks(
  limit: number = 10,
  roomId: string = DEFAULT_ROOM_ID
): Array<{ rank: number; name: string; score: number; streak: number }> {
  return sortByScore(roomId)
    .filter((entry) => entry.score > 0)
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      name: entry.username,
      score: entry.score,
      streak: entry.streak,
    }));
}

export function getTopStreaksWithScores(
  limit: number = 5,
  roomId: string = DEFAULT_ROOM_ID
): Array<{ rank: number; name: string; streak: number; score: number }> {
  return sortByStreak(roomId)
    .filter((entry) => entry.streak > 0)
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      name: entry.username,
      streak: entry.streak,
      score: entry.score,
    }));
}

export function getTopicStats(roomId: string = DEFAULT_ROOM_ID): {
  averageCorrectPct: number;
  totalParticipants: number;
  maxScore: number;
} {
  const roomState = getRoomState(roomId);
  const participants = Array.from(roomState.playerStates.entries())
    .map(([userId, playerState]) => ({ userId, score: playerState.score }))
    .filter(
      (participant) => roomState.playerCorrectCounts.has(participant.userId) || participant.score > 0
    );

  if (participants.length === 0) {
    return {
      averageCorrectPct: 0,
      totalParticipants: 0,
      maxScore: 0,
    };
  }

  let totalCorrectPct = 0;
  let playersWithAnswers = 0;

  for (const participant of participants) {
    const counts = roomState.playerCorrectCounts.get(participant.userId);
    if (counts && counts.total > 0) {
      totalCorrectPct += (counts.correct / counts.total) * 100;
      playersWithAnswers += 1;
    }
  }

  const averageCorrectPct = playersWithAnswers > 0
    ? Math.round(totalCorrectPct / playersWithAnswers)
    : 0;

  return {
    averageCorrectPct,
    totalParticipants: participants.length,
    maxScore: Math.max(0, ...participants.map((participant) => participant.score)),
  };
}

export function resetScoresAndStreaks(roomId: string = DEFAULT_ROOM_ID): void {
  const roomState = getRoomState(roomId);
  roomState.playerStates.forEach((playerState) => {
    playerState.score = 0;
    playerState.streak = 0;
  });
  roomState.playerCorrectCounts.clear();
  roomState.questionAnswers.clear();
  schedulePersistence();
  console.log(`[Players] [${roomId}] Scores and streaks reset (registrations preserved)`);
}

export function getPlayersPersistenceSnapshot(): PersistedPlayersSnapshot {
  return {
    players: [...players.values()],
    accountIdentities: [...accountIdentities.values()].map((mapping) => ({ ...mapping })),
    roomStates: [...roomStates.entries()].map(([roomId, roomState]) => ({
      roomId,
      playerStates: [...roomState.playerStates.entries()].map(([userId, playerState]) => ({
        userId,
        score: playerState.score,
        streak: playerState.streak,
      })),
      playerCorrectCounts: [...roomState.playerCorrectCounts.entries()].map(([userId, counts]) => ({
        userId,
        correct: counts.correct,
        total: counts.total,
      })),
      scoreEvents: roomState.scoreEvents.map((event) => ({ ...event })),
    })),
  };
}

export function hydratePlayersPersistenceSnapshot(snapshot: PersistedPlayersSnapshot | null | undefined): void {
  players.clear();
  usernameToUserId.clear();
  accountIdentities.clear();
  accountLinkedUserIds.clear();
  roomStates.clear();

  if (!snapshot) {
    return;
  }

  for (const player of snapshot.players || []) {
    players.set(player.userId, player);
    usernameToUserId.set(player.usernameLower, player.userId);
  }

  for (const mapping of snapshot.accountIdentities || []) {
    if (!mapping || typeof mapping.issuer !== "string" || typeof mapping.subject !== "string") continue;
    if (typeof mapping.userId !== "string" || !players.has(mapping.userId)) continue;
    accountIdentities.set(accountIdentityKey(mapping.issuer, mapping.subject), { ...mapping });
    accountLinkedUserIds.add(mapping.userId);
  }

  for (const persistedRoomState of snapshot.roomStates || []) {
    const roomState: RoomPlayerState = {
      playerStates: new Map(),
      questionAnswers: new Map(),
      playerCorrectCounts: new Map(),
      scoreEvents: (persistedRoomState.scoreEvents || []).map((event) => ({ ...event })),
    };

    for (const playerState of persistedRoomState.playerStates || []) {
      roomState.playerStates.set(playerState.userId, {
        score: playerState.score,
        streak: playerState.streak,
      });
    }

    for (const counts of persistedRoomState.playerCorrectCounts || []) {
      roomState.playerCorrectCounts.set(counts.userId, {
        correct: counts.correct,
        total: counts.total,
      });
    }

    roomStates.set(persistedRoomState.roomId, roomState);
  }
}
