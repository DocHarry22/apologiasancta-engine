/**
 * In-memory Content Bank
 *
 * Stores all imported questions and provides the active question pool for quizzes.
 * Questions are indexed by topic for efficient filtering.
 */

import { QuestionData } from "./questions";
import { UIQuestion, normalizeToEngine } from "./validate";

/** Question entry with metadata */
export interface BankEntry {
  id: string;
  topicId: string;
  difficulty: "easy" | "medium" | "hard";
  engineFormat: QuestionData;
  originalQuestion: UIQuestion;
}

/** Topic index entry */
export interface TopicSummary {
  topicId: string;
  count: number;
}

// In-memory storage
const bank: Map<string, BankEntry> = new Map();
const topicIndex: Map<string, Set<string>> = new Map();

// Active question pool for current quiz set
let activePool: BankEntry[] = [];

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
      difficulty: q.difficulty || "medium",
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

  activePool = [...questions];

  if (shuffle) {
    // Fisher-Yates shuffle
    for (let i = activePool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [activePool[i], activePool[j]] = [activePool[j], activePool[i]];
    }
  }

  return activePool.length;
}

/**
 * Get the size of the active pool
 */
export function getActivePoolSize(): number {
  return activePool.length;
}

/**
 * Get a question from the active pool by index
 */
export function getPoolQuestion(index: number): QuestionData | null {
  if (index < 0 || index >= activePool.length) {
    return null;
  }
  return activePool[index].engineFormat;
}

/**
 * Get active pool entry with metadata
 */
export function getPoolEntry(index: number): BankEntry | null {
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
  activePool = [];
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
export function isPoolEmpty(): boolean {
  return activePool.length === 0;
}
