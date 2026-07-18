/**
 * In-memory Content Bank
 *
 * Stores all imported questions and provides the active question pool for quizzes.
 * Questions are indexed by topic for efficient filtering.
 */

import { QuestionData } from "./questions";
import { UIQuestion, normalizeToEngine, validateQuestion } from "./validate";
import { schedulePersistence } from "../state/persistence";
import { DEFAULT_ROOM_ID } from "../state/rooms";

/** Question entry with metadata */
export interface BankEntry {
  id: string;
  topicId: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  engineFormat: QuestionData;
  originalQuestion: UIQuestion;
  /** Missing on legacy snapshots; only the canonical client may set canonical. */
  catalogSource?: "legacy" | "canonical";
}

export interface CatalogReplacementOptions {
  catalogSource?: "legacy" | "canonical";
  /** Drop any selected pool that was not created from canonical feed entries. */
  discardNonCanonicalPools?: boolean;
}

/** Topic index entry */
export interface TopicSummary {
  topicId: string;
  count: number;
}

export interface PersistedContentBankSnapshot {
  entries: BankEntry[];
  activePools?: Array<{
    roomId: string;
    questionIds: string[];
    /** Exact selected revisions, including entries retired from the catalog. */
    entries?: BankEntry[];
  }>;
  activePoolQuestionIds?: string[];
  /**
   * Non-secret checkpoint for the canonical content feed. Keeping this beside
   * the catalog makes ETag/version checks restart-safe without persisting the
   * feed URL or bearer credential.
   */
  canonicalContent?: PersistedCanonicalContentCache | null;
}

export interface CanonicalQuestionRevision {
  id: string;
  version: number;
  updatedAt?: string;
  digest: string;
}

export interface PersistedCanonicalContentCache {
  schemaVersion: 1;
  etag?: string;
  lastModified?: string;
  feedVersion?: string;
  feedUpdatedAt?: string;
  fingerprint?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastChangedAt?: string;
  lastError?: string;
  questionCount: number;
  revisions: CanonicalQuestionRevision[];
}

// In-memory storage
let bank: Map<string, BankEntry> = new Map();
let topicIndex: Map<string, Set<string>> = new Map();
let canonicalContentCache: PersistedCanonicalContentCache | null = null;

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

function buildBankEntry(
  question: UIQuestion,
  catalogSource: "legacy" | "canonical" = "legacy"
): BankEntry {
  return {
    id: question.id,
    topicId: question.topicId,
    difficulty: normalizeDifficultyLevel(question.difficulty),
    engineFormat: normalizeToEngine(question),
    originalQuestion: question,
    catalogSource,
  };
}

/**
 * Replace the catalog in one synchronous commit.
 *
 * The replacement is fully validated and indexed before the live references are
 * swapped. Existing room pools intentionally retain their current immutable
 * entries so a content refresh cannot change a question or correct answer in the
 * middle of an answer window. A room picks up the replacement catalog the next
 * time its pool/topic is selected.
 */
export function replaceCatalogAtomically(
  questions: UIQuestion[],
  options: CatalogReplacementOptions = {}
): {
  added: number;
  updated: number;
  removed: number;
  ids: string[];
} {
  const nextBank = new Map<string, BankEntry>();
  const nextTopicIndex = new Map<string, Set<string>>();

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const validation = validateQuestion(question);
    if (!validation.valid) {
      throw new Error(`Invalid question at index ${index}: ${validation.errors.join("; ")}`);
    }
    if (nextBank.has(question.id)) {
      throw new Error(`Duplicate question id in replacement catalog: ${question.id}`);
    }

    const entry = buildBankEntry(question, options.catalogSource ?? "legacy");
    nextBank.set(question.id, entry);
    const topicQuestionIds = nextTopicIndex.get(question.topicId) ?? new Set<string>();
    topicQuestionIds.add(question.id);
    nextTopicIndex.set(question.topicId, topicQuestionIds);
  }

  const previousIds = new Set(bank.keys());
  const ids = [...nextBank.keys()];
  const added = ids.filter((id) => !previousIds.has(id)).length;
  const updated = ids.length - added;
  const removed = [...previousIds].filter((id) => !nextBank.has(id)).length;

  // Map reference replacement is atomic with respect to the Node event loop;
  // readers can observe the complete old catalog or the complete new one only.
  bank = nextBank;
  topicIndex = nextTopicIndex;
  if (options.discardNonCanonicalPools) {
    for (const [roomId, pool] of activePools.entries()) {
      if (pool.some((entry) => entry.catalogSource !== "canonical")) {
        activePools.delete(roomId);
      }
    }
  }
  schedulePersistence();

  return { added, updated, removed, ids };
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
    const entry = buildBankEntry(q);

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
  canonicalContentCache = null;
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
      entries: pool.map((entry) => structuredClone(entry)),
    })),
    activePoolQuestionIds: getStoredPool(DEFAULT_ROOM_ID).map((entry) => entry.id),
    canonicalContent: canonicalContentCache ? structuredClone(canonicalContentCache) : null,
  };
}

export function getCanonicalContentCache(): PersistedCanonicalContentCache | null {
  return canonicalContentCache ? structuredClone(canonicalContentCache) : null;
}

/**
 * Required-mode trust check. Older snapshots and every legacy import lack
 * canonical provenance, so they cannot be mistaken for the authoritative feed.
 */
export function hasCanonicalCatalogProvenance(): boolean {
  if (!canonicalContentCache || bank.size === 0 || bank.size !== canonicalContentCache.questionCount) {
    return false;
  }
  const currentRevisionIds = new Set(canonicalContentCache.revisions.map((revision) => revision.id));
  for (const entry of bank.values()) {
    if (entry.catalogSource !== "canonical" || !currentRevisionIds.has(entry.id)) return false;
  }
  for (const pool of activePools.values()) {
    if (pool.some((entry) => entry.catalogSource !== "canonical")) return false;
  }
  return true;
}

export function setCanonicalContentCache(cache: PersistedCanonicalContentCache): void {
  canonicalContentCache = structuredClone(cache);
  schedulePersistence();
}

export function clearCanonicalContentCache(): void {
  canonicalContentCache = null;
  schedulePersistence();
}

export function hydrateContentBankPersistenceSnapshot(
  snapshot: PersistedContentBankSnapshot | null | undefined
): void {
  bank.clear();
  topicIndex.clear();
  activePools.clear();
  canonicalContentCache = null;

  if (!snapshot) {
    return;
  }

  canonicalContentCache = snapshot.canonicalContent
    ? structuredClone(snapshot.canonicalContent)
    : null;

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
      const embeddedEntries = persistedPool.entries;
      activePools.set(
        persistedPool.roomId,
        Array.isArray(embeddedEntries)
          ? embeddedEntries.map((entry) => structuredClone(entry))
          : (persistedPool.questionIds || [])
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
