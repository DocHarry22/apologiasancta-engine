import { disposeRoomController } from "../engine/roundController";
import type { RoomSummary } from "../types/quiz";
import { closeRoom, DEFAULT_ROOM_ID, getRoom } from "./rooms";

export interface CloseGameplayRoomResult {
  room: RoomSummary;
  controllerDisposed: boolean;
}

/**
 * Close a room and stop its controller in one synchronous lifecycle mutation.
 * `closeRoom` owns the single debounced persistence request, so the resulting
 * snapshot sees both the inactive room and the disposed controller.
 */
export function closeGameplayRoom(roomId: string): CloseGameplayRoomResult {
  if (roomId === DEFAULT_ROOM_ID) {
    throw new Error("The default global room cannot be closed");
  }
  if (!getRoom(roomId)) {
    throw new Error("Room not found");
  }

  const controllerDisposed = disposeRoomController(roomId);
  const room = closeRoom(roomId);
  return { room, controllerDisposed };
}
