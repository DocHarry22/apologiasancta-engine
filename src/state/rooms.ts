import type { RoomMembership, RoomSummary } from "../types/quiz";
import { schedulePersistence, type PersistenceMutation } from "./persistence";

interface RoomRecord extends RoomSummary {
  createdAt: number;
  closedAt?: number;
}

export interface PersistedRoomsSnapshot {
  rooms: Array<{
    roomId: string;
    name: string;
    isActive: boolean;
    createdAt: number;
    closedAt?: number;
  }>;
  memberships: RoomMembership[];
}

export const DEFAULT_ROOM_ID = "global";
const ROOM_ID_REGEX = /^[a-z0-9-]{3,40}$/;
const rooms = new Map<string, RoomRecord>();
const roomMemberships = new Map<string, Map<string, RoomMembership>>();

function getMemberships(roomId: string): Map<string, RoomMembership> {
  let memberships = roomMemberships.get(roomId);
  if (!memberships) {
    memberships = new Map();
    roomMemberships.set(roomId, memberships);
  }
  return memberships;
}

function slugifyRoomId(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.slice(0, 40);
}

function buildUniqueRoomId(baseId: string): string {
  let candidate = baseId;
  let suffix = 2;

  while (rooms.has(candidate)) {
    const extra = `-${suffix}`;
    candidate = `${baseId.slice(0, Math.max(1, 40 - extra.length))}${extra}`;
    suffix += 1;
  }

  return candidate;
}

function ensureDefaultRoom() {
  if (rooms.has(DEFAULT_ROOM_ID)) {
    return;
  }

  rooms.set(DEFAULT_ROOM_ID, {
    roomId: DEFAULT_ROOM_ID,
    name: "Global Room",
    isActive: true,
    playerCount: 0,
    createdAt: Date.now(),
  });
  getMemberships(DEFAULT_ROOM_ID);
}

ensureDefaultRoom();

export function listRooms(includeClosed = false): RoomSummary[] {
  ensureDefaultRoom();

  return [...rooms.values()]
    .filter((room) => includeClosed || room.isActive)
    .sort((left, right) => {
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }

      return left.createdAt - right.createdAt;
    })
    .map(({ roomId, name, isActive, playerCount }) => ({
      roomId,
      name,
      isActive,
      playerCount,
    }));
}

export function getRoom(roomId: string): RoomSummary | null {
  ensureDefaultRoom();
  const room = rooms.get(roomId);
  if (!room) {
    return null;
  }

  const { name, isActive } = room;
  return { roomId, name, isActive, playerCount: getMemberships(roomId).size };
}

export function getRoomName(roomId: string): string | undefined {
  return rooms.get(roomId)?.name;
}

export function createRoom(name: string, requestedRoomId?: string): RoomSummary {
  ensureDefaultRoom();

  const trimmedName = name.trim();
  if (trimmedName.length < 3 || trimmedName.length > 60) {
    throw new Error("Room name must be between 3 and 60 characters");
  }

  const rawId = requestedRoomId?.trim().toLowerCase() || slugifyRoomId(trimmedName);
  if (!rawId || !ROOM_ID_REGEX.test(rawId)) {
    throw new Error("Room ID must be 3-40 characters of lowercase letters, numbers, or dashes");
  }

  const roomId = buildUniqueRoomId(rawId);
  const room: RoomRecord = {
    roomId,
    name: trimmedName,
    isActive: true,
    playerCount: 0,
    createdAt: Date.now(),
  };

  rooms.set(roomId, room);
  getMemberships(roomId);
  schedulePersistence();
  return getRoom(roomId)!;
}

export function closeRoom(roomId: string): RoomSummary {
  ensureDefaultRoom();

  if (roomId === DEFAULT_ROOM_ID) {
    throw new Error("The default global room cannot be closed");
  }

  const room = rooms.get(roomId);
  if (!room) {
    throw new Error("Room not found");
  }

  room.isActive = false;
  room.closedAt = Date.now();
  rooms.set(roomId, room);
  schedulePersistence();
  return getRoom(roomId)!;
}

export function requireRoom(roomId: string): RoomSummary {
  const room = getRoom(roomId);
  if (!room) {
    throw new Error("Room not found");
  }

  return room;
}

export function isGameplayRoomSupported(roomId: string): boolean {
  return Boolean(getRoom(roomId)?.isActive);
}

function syncRoomPlayerCount(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  room.playerCount = getMemberships(roomId).size;
  rooms.set(roomId, room);
}

export function joinRoom(roomId: string, userId: string): RoomMembership {
  const room = requireRoom(roomId);
  if (!room.isActive) {
    throw new Error("Room is closed");
  }

  const memberships = getMemberships(roomId);
  const existing = memberships.get(userId);
  if (existing) {
    return existing;
  }

  const membership: RoomMembership = {
    roomId,
    userId,
    joinedAt: Date.now(),
  };

  memberships.set(userId, membership);
  syncRoomPlayerCount(roomId);
  schedulePersistence();
  return membership;
}

export function beginRoomJoin(roomId: string, userId: string): PersistenceMutation<RoomMembership> {
  const memberships = getMemberships(roomId);
  const previousMembership = memberships.get(userId);
  const membership = joinRoom(roomId, userId);

  return {
    value: membership,
    rollback: () => {
      if (previousMembership || memberships.get(userId) !== membership) return;
      memberships.delete(userId);
      syncRoomPlayerCount(roomId);
      schedulePersistence();
    },
  };
}

export function leaveRoom(roomId: string, userId: string): boolean {
  const memberships = getMemberships(roomId);
  const deleted = memberships.delete(userId);
  if (deleted) {
    syncRoomPlayerCount(roomId);
    schedulePersistence();
  }
  return deleted;
}

export function isPlayerInRoom(roomId: string, userId: string): boolean {
  return getMemberships(roomId).has(userId);
}

export function getPlayerRooms(userId: string): RoomSummary[] {
  ensureDefaultRoom();
  return listRooms(true).filter((room) => getMemberships(room.roomId).has(userId));
}

export function getRoomsPersistenceSnapshot(): PersistedRoomsSnapshot {
  ensureDefaultRoom();

  return {
    rooms: [...rooms.values()].map(({ roomId, name, isActive, createdAt, closedAt }) => ({
      roomId,
      name,
      isActive,
      createdAt,
      closedAt,
    })),
    memberships: [...roomMemberships.values()].flatMap((memberships) => [...memberships.values()]),
  };
}

export function hydrateRoomsPersistenceSnapshot(snapshot: PersistedRoomsSnapshot | null | undefined): void {
  rooms.clear();
  roomMemberships.clear();

  if (snapshot) {
    for (const room of snapshot.rooms || []) {
      rooms.set(room.roomId, {
        roomId: room.roomId,
        name: room.name,
        isActive: room.isActive,
        playerCount: 0,
        createdAt: room.createdAt,
        closedAt: room.closedAt,
      });
      getMemberships(room.roomId);
    }

    for (const membership of snapshot.memberships || []) {
      if (!rooms.has(membership.roomId)) {
        continue;
      }

      getMemberships(membership.roomId).set(membership.userId, membership);
    }
  }

  ensureDefaultRoom();

  for (const roomId of rooms.keys()) {
    syncRoomPlayerCount(roomId);
  }
}
