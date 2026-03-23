/**
 * In-memory quiz state store
 *
 * This module now delegates to the RoundController for state management.
 */

import type { QuizState } from "../types/quiz";
import { getCurrentState } from "../engine/roundController";
import { DEFAULT_ROOM_ID, getRoom } from "./rooms";
import { getTopScorers, getTopStreaks } from "./players";

/**
 * Get current quiz state from controller
 */
export function getState(): QuizState {
  return getCurrentState();
}

export function getStateForRoom(roomId: string = DEFAULT_ROOM_ID): QuizState {
  const baseState = getCurrentState(roomId);
  const room = getRoom(roomId);

  return {
    ...baseState,
    roomId,
    roomName: room?.name,
    leaderboard: {
      topScorers: getTopScorers(10, roomId),
      topStreaks: getTopStreaks(5, roomId),
      scope: "room",
      roomId,
      roomName: room?.name,
      period: baseState.leaderboard.period ?? "all-time",
      snapshotAtMs: Date.now(),
    },
  };
}
