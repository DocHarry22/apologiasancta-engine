import type { AnswerResultEvent, LeaderboardChangedEvent, QuizState, RoomSummary, StageChangedEvent } from "../types/quiz";

export type LiveEvent = AnswerResultEvent | LeaderboardChangedEvent | StageChangedEvent | QuizState;

export interface RoomStorageAdapter {
  listRooms(includeClosed?: boolean): Promise<RoomSummary[]>;
  getRoom(roomId: string): Promise<RoomSummary | null>;
  createRoom(name: string, requestedRoomId?: string): Promise<RoomSummary>;
  closeRoom(roomId: string): Promise<RoomSummary>;
  joinRoom(roomId: string, userId: string): Promise<void>;
  leaveRoom(roomId: string, userId: string): Promise<void>;
}

export interface ScoreStorageAdapter {
  recordAnswer(input: {
    roomId: string;
    userId: string;
    questionIndex: number;
    choiceId: string;
    acceptedAtMs: number;
  }): Promise<"accepted" | "already_answered">;
  recordScoreEvent(input: {
    roomId: string;
    userId: string;
    points: number;
    streak: number;
    atMs: number;
  }): Promise<void>;
}

export interface ControllerCheckpointAdapter {
  getCheckpoint(roomId: string): Promise<unknown | null>;
  saveCheckpoint(roomId: string, checkpoint: unknown): Promise<void>;
}

export interface LiveEventBus {
  publish(roomId: string, event: LiveEvent): Promise<void>;
  subscribe(roomId: string, handler: (event: LiveEvent) => void): Promise<() => Promise<void> | void>;
}

export interface DistributedLockAdapter {
  withRoomLock<T>(roomId: string, lockName: string, run: () => Promise<T>): Promise<T>;
}

export interface ProductionAdapters {
  rooms: RoomStorageAdapter;
  scores: ScoreStorageAdapter;
  checkpoints: ControllerCheckpointAdapter;
  events: LiveEventBus;
  locks: DistributedLockAdapter;
}

export function shouldUseProductionAdapters(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
}
