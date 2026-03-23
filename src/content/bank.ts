/**
 * In-memory Content Bank
 *
 * Stores all imported questions and provides the active question pool for quizzes.
 * Questions are indexed by topic for efficient filtering.
 */

import { QuestionData } from "./questions";
import { UIQuestion, normalizeToEngine } from "./validate";
import { schedulePersistence } from "../state/persistence";
import { DEFAULT_ROOM_ID } from "../state/rooms";

/** Question entry with metadata */
export interface BankEntry {
  id: string;
  topicId: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  engineFormat: QuestionData;
  originalQuestion: UIQuestion;
}

/** Topic index entry */
export interface TopicSummary {
  topicId: string;
  count: number;
}

export interface PersistedContentBankSnapshot {
  entries: BankEntry[];
  activePools?: Array<{ roomId: string; questionIds: string[] }>;
  activePoolQuestionIds?: string[];
}

// In-memory storage
const bank: Map<string, BankEntry> = new Map();
const topicIndex: Map<string, Set<string>> = new Map();

const activePools: Map<string, BankEntry[]> = new Map();

function getStoredPool(roomId: string = DEFAULT_ROOM_ID): BankEntry[] {
  return activePools.get(roomId) || [];
}

function normalizeDifficultyLevel(
  difficulty?: UIQuestion["difficulty"]
): 1 | 2 | 3 | 4 | 5 {
  if (typeof difficulty === "number" && Number.isFinite(difficulty)) {
    const rounded = Math.round(difficulty);
    if (rounded < 1) return 1;
    if (rounded > 5) return 5;
    return rounded as 1 | 2 | 3 | 4 | 5;
  }

  if (difficulty === "easy") return 2;
  if (difficulty === "hard") return 4;
  return 3;
}

/**
 * Ingest a batch of UI questions into the bank
 *
 * @param questions - Array of validated UI questions
 * @returns Number of questions added
 */
export function ingestQuestions(questions: UIQuestion[]): {
  added: number;
  updated: number;
  ids: string[];
} {
  let added = 0;
  let updated = 0;
  const ids: string[] = [];

  for (const q of questions) {
    const entry: BankEntry = {
      id: q.id,
      topicId: q.topicId,
      difficulty: normalizeDifficultyLevel(q.difficulty),
      engineFormat: normalizeToEngine(q),
      originalQuestion: q,
    };

    const exists = bank.has(q.id);
    bank.set(q.id, entry);

    // Update topic index
    if (!topicIndex.has(q.topicId)) {
      topicIndex.set(q.topicId, new Set());
    }
    topicIndex.get(q.topicId)!.add(q.id);

    if (exists) {
      updated++;
    } else {
      added++;
    }

    ids.push(q.id);
  }

  schedulePersistence();

  return { added, updated, ids };
}

/**
 * Get all questions for a topic
 */
export function getTopicQuestions(topicId: string): BankEntry[] {
  const questionIds = topicIndex.get(topicId);
  if (!questionIds) return [];

  return Array.from(questionIds)
    .map((id) => bank.get(id)!)
    .filter(Boolean);
}

/**
 * Get bank summary by topic
 */
export function getTopicSummaries(): TopicSummary[] {
  const summaries: TopicSummary[] = [];

  for (const [topicId, ids] of topicIndex.entries()) {
    summaries.push({
      topicId,
      count: ids.size,
    });
  }

  return summaries.sort((a, b) => a.topicId.localeCompare(b.topicId));
}

/**
 * Get total number of questions in bank
 */
export function getTotalBankSize(): number {
  return bank.size;
}

/**
 * Get all unique topic IDs in the bank
 */
export function getAllTopicIds(): string[] {
  return Array.from(topicIndex.keys()).sort();
}

/**
 * Set the active question pool for quizzes
 *
 * @param topicIds - Array of topic IDs to include (empty = all topics)
 * @param shuffle - Whether to randomize the order
 */
export function setActivePool(topicIds: string[], shuffle: boolean = true): number {
  const questions: BankEntry[] = [];

  if (topicIds.length === 0) {
    // Use all topics
    questions.push(...bank.values());
  } else {
    // Filter by specified topics
    for (const topicId of topicIds) {
      questions.push(...getTopicQuestions(topicId));
    }
  }

  const nextPool = [...questions];

  if (shuffle) {
    // Fisher-Yates shuffle
    for (let i = nextPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nextPool[i], nextPool[j]] = [nextPool[j], nextPool[i]];
    }
  }

  activePools.set(DEFAULT_ROOM_ID, nextPool);

  schedulePersistence();

  return nextPool.length;
}

export function setActivePoolForRoom(
  topicIds: string[],
  shuffle: boolean = true,
  roomId: string = DEFAULT_ROOM_ID
): number {
  const questions: BankEntry[] = [];

  if (topicIds.length === 0) {
    questions.push(...bank.values());
  } else {
    for (const topicId of topicIds) {
      questions.push(...getTopicQuestions(topicId));
    }
  }

  const nextPool = [...questions];
  if (shuffle) {
    for (let index = nextPool.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [nextPool[index], nextPool[swapIndex]] = [nextPool[swapIndex], nextPool[index]];
    }
  }

  activePools.set(roomId, nextPool);
  schedulePersistence();
  return nextPool.length;
}

/**
 * Get the size of the active pool
 */
export function getActivePoolSize(roomId: string = DEFAULT_ROOM_ID): number {
  return getStoredPool(roomId).length;
}

/**
 * Get topic IDs currently in the active pool
 */
export function getActivePoolTopicIds(roomId: string = DEFAULT_ROOM_ID): string[] {
  const topicIds = new Set<string>();
  for (const entry of getStoredPool(roomId)) {
    topicIds.add(entry.topicId);
  }
  return Array.from(topicIds);
}

/**
 * Get the current active topic ID (if pool contains only one topic)
 * Returns null if pool has multiple topics or is empty
 */
export function getActiveTopicId(roomId: string = DEFAULT_ROOM_ID): string | null {
  const topicIds = getActivePoolTopicIds(roomId);
  if (topicIds.length === 1) {
    return topicIds[0];
  }
  return null;
}

/**
 * Convert topic ID to display title
 * E.g., "genesis-chapter-1" -> "Genesis Chapter 1"
 */
export function topicIdToTitle(topicId: string): string {
  return topicId
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get a question from the active pool by index
 */
export function getPoolQuestion(index: number, roomId: string = DEFAULT_ROOM_ID): QuestionData | null {
  const activePool = getStoredPool(roomId);
  if (index < 0 || index >= activePool.length) {
    return null;
  }
  return activePool[index].engineFormat;
}

/**
 * Get active pool entry with metadata
 */
export function getPoolEntry(index: number, roomId: string = DEFAULT_ROOM_ID): BankEntry | null {
  const activePool = getStoredPool(roomId);
  if (index < 0 || index >= activePool.length) {
    return null;
  }
  return activePool[index];
}

/**
 * Clear all questions from the bank
 */
export function clearBank(): void {
  bank.clear();
  topicIndex.clear();
  activePools.clear();
  schedulePersistence();
}

/**
 * Get a specific question by ID
 */
export function getQuestionById(id: string): BankEntry | null {
  return bank.get(id) || null;
}

/**
 * Remove a question from the bank
 */
export function removeQuestion(id: string): boolean {
  const entry = bank.get(id);
  if (!entry) return false;

  bank.delete(id);

  const topicIds = topicIndex.get(entry.topicId);
  if (topicIds) {
    topicIds.delete(id);
    if (topicIds.size === 0) {
      topicIndex.delete(entry.topicId);
    }
  }

  activePools.forEach((pool, roomId) => {
    activePools.set(
      roomId,
      pool.filter((poolEntry) => poolEntry.id !== id)
    );
  });
  schedulePersistence();

  return true;
}

/**
 * Check if bank has any questions
 */
export function isBankEmpty(): boolean {
  return bank.size === 0;
}

/**
 * Check if active pool has been set
 */
export function isPoolEmpty(roomId: string = DEFAULT_ROOM_ID): boolean {
  return getStoredPool(roomId).length === 0;
}

export function getContentBankPersistenceSnapshot(): PersistedContentBankSnapshot {
  return {
    entries: [...bank.values()],
    activePools: [...activePools.entries()].map(([roomId, pool]) => ({
      roomId,
      questionIds: pool.map((entry) => entry.id),
    })),
    activePoolQuestionIds: getStoredPool(DEFAULT_ROOM_ID).map((entry) => entry.id),
  };
}

export function hydrateContentBankPersistenceSnapshot(
  snapshot: PersistedContentBankSnapshot | null | undefined
): void {
  bank.clear();
  topicIndex.clear();
  activePools.clear();

  if (!snapshot) {
    return;
  }

  for (const entry of snapshot.entries || []) {
    bank.set(entry.id, entry);
    if (!topicIndex.has(entry.topicId)) {
      topicIndex.set(entry.topicId, new Set());
    }
    topicIndex.get(entry.topicId)!.add(entry.id);
  }

  const persistedPools = snapshot.activePools;
  if (persistedPools && persistedPools.length > 0) {
    for (const persistedPool of persistedPools) {
      activePools.set(
        persistedPool.roomId,
        (persistedPool.questionIds || [])
          .map((id) => bank.get(id))
          .filter((entry): entry is BankEntry => Boolean(entry))
      );
    }
    return;
  }

  activePools.set(
    DEFAULT_ROOM_ID,
    (snapshot.activePoolQuestionIds || [])
      .map((id) => bank.get(id))
      .filter((entry): entry is BankEntry => Boolean(entry))
  );
}
