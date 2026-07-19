import { createHash } from "node:crypto";
import {
  getCanonicalContentCache,
  hasCanonicalCatalogProvenance,
  getTopicSummaries,
  getTotalBankSize,
  replaceCatalogAtomically,
  setCanonicalContentCache,
  type CanonicalQuestionRevision,
  type PersistedCanonicalContentCache,
} from "./bank";
import type { UIChoiceId, UIQuestion } from "./validate";
import { assertCanonicalGovernanceRecord } from "./governance";

const CHOICE_IDS: UIChoiceId[] = ["A", "B", "C", "D"];
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface CanonicalContentConfig {
  url: string;
  token: string;
  timeoutMs: number;
  maxBytes: number;
}

export interface CanonicalContentSyncResult {
  success: boolean;
  topicsLoaded: number;
  questionsLoaded: number;
  errors: string[];
  notModified: boolean;
  staleCacheRetained: boolean;
  feedVersion?: string;
}

export interface CanonicalContentStatus {
  source: "canonical_content_api";
  configured: boolean;
  required: boolean;
  ready: boolean;
  stale: boolean;
  state: "disabled" | "missing_configuration" | "never_synced" | "fresh" | "stale";
  questionCount: number;
  feedVersion?: string;
  feedUpdatedAt?: string;
  etagPresent: boolean;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastChangedAt?: string;
  lastError?: string;
}

interface ParsedFeed {
  questions: UIQuestion[];
  revisions: CanonicalQuestionRevision[];
  feedVersion: string;
  feedUpdatedAt?: string;
  fingerprint: string;
}

interface CanonicalFeedEnvelope {
  questions?: unknown;
  data?: unknown;
  version?: unknown;
  updatedAt?: unknown;
  updated_at?: unknown;
}

let fetchOverride: FetchImplementation | null = null;
let refreshInFlight: Promise<CanonicalContentSyncResult> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function trimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function isCanonicalContentRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return trimmed(env, "CONTENT_API_REQUIRED") === "true";
}

export function getCanonicalContentConfig(
  env: NodeJS.ProcessEnv = process.env
): CanonicalContentConfig | null {
  const url = trimmed(env, "CONTENT_API_URL");
  const token = trimmed(env, "CONTENT_API_TOKEN");
  if (!url || !token) return null;

  return {
    url,
    token,
    timeoutMs: boundedInteger(env.CONTENT_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 500, 60_000),
    maxBytes: boundedInteger(env.CONTENT_API_MAX_BYTES, DEFAULT_MAX_BYTES, 64 * 1024, 25 * 1024 * 1024),
  };
}

export function getCanonicalRefreshIntervalMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = trimmed(env, "CONTENT_API_REFRESH_INTERVAL_MS");
  if (!raw || raw === "0") return 0;
  return boundedInteger(raw, 0, 30_000, 24 * 60 * 60 * 1000);
}

export function assertCanonicalContentConfiguration(
  env: NodeJS.ProcessEnv = process.env
): void {
  const url = trimmed(env, "CONTENT_API_URL");
  const token = trimmed(env, "CONTENT_API_TOKEN");
  const required = isCanonicalContentRequired(env);
  const production = env.NODE_ENV === "production";

  if ((url && !token) || (!url && token) || (required && (!url || !token))) {
    throw new Error(
      "CONTENT_API_URL and CONTENT_API_TOKEN must be configured together when canonical content is enabled"
    );
  }
  if (!url || !token) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("CONTENT_API_URL must be an absolute URL");
  }

  if (parsed.username || parsed.password) {
    throw new Error("CONTENT_API_URL must not contain URL user-info credentials");
  }
  if (production && parsed.protocol !== "https:") {
    throw new Error("CONTENT_API_URL must use HTTPS in production");
  }
  if ((production || required) && token.length < 32) {
    throw new Error("CONTENT_API_TOKEN must contain at least 32 characters");
  }
  if ((production || required) && /^(?:your-|replace|change-?me|placeholder|example)/i.test(token)) {
    throw new Error("CONTENT_API_TOKEN must not use a documented placeholder value");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") {
    const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    return normalized || undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractText(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["text", "body", "content", "value", "label", "citation", "prompt", "blocks"]) {
    const extracted = extractText(record[key], depth + 1);
    if (extracted) return extracted;
  }
  return undefined;
}

function requireBoundedText(value: unknown, field: string, maximum: number): string {
  const text = extractText(value);
  if (!text) throw new Error(`${field} must contain text`);
  if (text.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return text;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => extractText(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 50)
    .map((entry) => entry.slice(0, 500));
}

function normalizedDifficulty(value: unknown): 1 | 2 | 3 | 4 | 5 {
  if (typeof value !== "number" || !Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(5, Math.round(value))) as 1 | 2 | 3 | 4 | 5;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function isExplicitlyExcluded(record: Record<string, unknown>): boolean {
  const status = readString(record, "status", "publicationStatus", "publication_status");
  if (status && status.toLowerCase() !== "published") return true;

  const retirement = readString(record, "retirementStatus", "retirement_status");
  if (retirement && retirement.toLowerCase() !== "active") return true;

  for (const key of ["liveEligible", "live_eligible", "enabled"]) {
    if (record[key] === false) return true;
  }
  return false;
}

function mapCanonicalQuestion(
  value: unknown,
  feedUpdatedAt: string | undefined
): { question: UIQuestion; revision: CanonicalQuestionRevision } | null {
  const record = asRecord(value);
  if (!record) throw new Error("question entry must be an object");
  if (isExplicitlyExcluded(record)) return null;
  assertCanonicalGovernanceRecord(record);

  const questionType = readString(record, "questionType", "question_type", "type");
  if (questionType && !["multiple_choice", "single_choice", "mcq", "multiple-choice"].includes(questionType)) {
    throw new Error(`unsupported live question type: ${questionType}`);
  }

  const id = readString(record, "id", "stableKey", "stable_key", "questionId", "question_id");
  if (!id || id.length > 200) throw new Error("question id is missing or too long");

  const rawVersion = record.version;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 1) {
    throw new Error(`question ${id} must have a positive integer version`);
  }
  const version = rawVersion;
  const topicId = readString(
    record,
    "topicId",
    "topic_id",
    "groupId",
    "group_id",
    "subjectId",
    "subject_id",
    "lessonId",
    "lesson_id"
  ) ?? "canonical-live";
  if (topicId.length > 200) throw new Error(`question ${id} topicId is too long`);

  const prompt = requireBoundedText(record.prompt ?? record.question, `question ${id} prompt`, 5_000);
  const optionsValue = record.options ?? record.answerOptions ?? record.answer_options ?? record.choices;
  let options: Array<Record<string, unknown>>;
  if (Array.isArray(optionsValue)) {
    options = optionsValue.map((option) => {
      const parsed = asRecord(option);
      if (!parsed) throw new Error(`question ${id} option must be an object`);
      return parsed;
    });
    options.sort((left, right) => {
      const leftPosition = typeof left.position === "number" ? left.position : Number.MAX_SAFE_INTEGER;
      const rightPosition = typeof right.position === "number" ? right.position : Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition;
    });
  } else {
    const choices = asRecord(optionsValue);
    options = choices
      ? Object.entries(choices).map(([optionId, optionText]) => ({ id: optionId, label: optionText }))
      : [];
  }

  if (options.length !== CHOICE_IDS.length) {
    throw new Error(`question ${id} must have exactly four options for the live engine`);
  }

  const canonicalCorrectId = readString(
    record,
    "correctOptionId",
    "correct_option_id",
    "correctId",
    "correct_id"
  );
  const correctIndexes = options
    .map((option, index) => option.isCorrect === true || option.is_correct === true ? index : -1)
    .filter((index) => index >= 0);
  const correctIndex = canonicalCorrectId
    ? options.findIndex((option) => readString(option, "id", "optionId", "option_id") === canonicalCorrectId)
    : correctIndexes.length === 1 ? correctIndexes[0]! : -1;
  if (correctIndex < 0 || (correctIndexes.length > 1)) {
    throw new Error(`question ${id} must identify exactly one correct option`);
  }

  const choices = {} as UIQuestion["choices"];
  options.forEach((option, index) => {
    const text = requireBoundedText(
      option.text ?? option.content ?? option.label ?? option.value,
      `question ${id} option ${index + 1}`,
      2_000
    );
    choices[CHOICE_IDS[index]!] = text;
  });

  const explanationValue = record.explanation
    ?? record.correctAnswerExplanation
    ?? record.correct_answer_explanation;
  const explanationRecord = asRecord(explanationValue);
  const explanation = extractText(explanationValue) ?? "The answer explanation is available after reveal.";
  if (explanation.length > 10_000) throw new Error(`question ${id} explanation is too long`);
  const sources = readStringArray(
    record.sources
    ?? explanationRecord?.sources
    ?? explanationRecord?.refs
    ?? explanationRecord?.references
  );
  const tags = readStringArray(record.tags);

  const question: UIQuestion = {
    id,
    topicId,
    difficulty: normalizedDifficulty(record.difficulty),
    question: prompt,
    choices,
    correctId: CHOICE_IDS[correctIndex]!,
    teaching: {
      title: readString(explanationRecord ?? {}, "title") ?? "Answer explanation",
      body: explanation,
      refs: sources,
    },
    tags,
  };
  const updatedAt = readString(record, "updatedAt", "updated_at") ?? feedUpdatedAt;
  if (updatedAt && !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error(`question ${id} updatedAt must be an ISO timestamp`);
  }
  return {
    question,
    revision: {
      id,
      version,
      ...(updatedAt ? { updatedAt } : {}),
      digest: stableDigest(question),
    },
  };
}

function parseFeed(value: unknown): ParsedFeed {
  const envelope = asRecord(value) as CanonicalFeedEnvelope | null;
  const hasVersionedEnvelope = Array.isArray(envelope?.questions);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(envelope?.questions)
      ? envelope.questions
      : Array.isArray(envelope?.data)
        ? envelope.data
        : null;
  if (!rows) throw new Error("canonical content response must contain a questions array");

  const feedUpdatedAt = typeof envelope?.updatedAt === "string"
    ? envelope.updatedAt
    : typeof envelope?.updated_at === "string" ? envelope.updated_at : undefined;
  if (feedUpdatedAt && !Number.isFinite(Date.parse(feedUpdatedAt))) {
    throw new Error("canonical content feed updatedAt must be an ISO timestamp");
  }
  const mapped = rows
    .map((row) => mapCanonicalQuestion(row, feedUpdatedAt))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (mapped.length === 0) {
    throw new Error("canonical content response contained no eligible live questions");
  }

  const ids = new Set<string>();
  for (const entry of mapped) {
    if (ids.has(entry.question.id)) throw new Error(`duplicate canonical question id: ${entry.question.id}`);
    ids.add(entry.question.id);
  }

  const revisions = mapped.map((entry) => entry.revision);
  const fingerprint = stableDigest(
    [...revisions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, version, updatedAt, digest }) => ({ id, version, updatedAt, digest }))
  );
  const explicitVersion = envelope && typeof envelope.version === "string" && envelope.version.trim()
    ? envelope.version.trim()
    : undefined;
  if (hasVersionedEnvelope && !explicitVersion) {
    throw new Error("canonical content feed version is required");
  }

  return {
    questions: mapped.map((entry) => entry.question),
    revisions,
    feedVersion: explicitVersion ?? fingerprint,
    ...(feedUpdatedAt ? { feedUpdatedAt } : {}),
    fingerprint,
  };
}

function validateRevisionProgression(
  previous: PersistedCanonicalContentCache | null,
  next: ParsedFeed
): void {
  if (!previous) return;
  const priorById = new Map(previous.revisions.map((revision) => [revision.id, revision]));
  for (const revision of next.revisions) {
    const prior = priorById.get(revision.id);
    if (!prior) continue;
    if (revision.version < prior.version) {
      throw new Error(`canonical question ${revision.id} version regressed`);
    }
    if (revision.version === prior.version && revision.digest !== prior.digest) {
      throw new Error(`canonical question ${revision.id} changed without a version increment`);
    }
  }
}

function safeError(error: unknown): string {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "Canonical content request timed out";
  }
  if (error instanceof Error) {
    const withoutUrls = error.message.replace(/https?:\/\/\S+/gi, "[redacted-url]");
    return withoutUrls.slice(0, 500);
  }
  return "Canonical content refresh failed";
}

function cacheAfterFailure(error: string, attemptedAt: string): PersistedCanonicalContentCache {
  const previous = getCanonicalContentCache();
  return {
    ...(previous ?? { questionCount: 0, revisions: [] }),
    schemaVersion: 1,
    lastAttemptAt: attemptedAt,
    lastError: error,
  };
}

async function readJsonWithinLimit(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error("Canonical content response exceeded the configured size limit");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error("Canonical content response exceeded the configured size limit");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Canonical content response was not valid JSON");
  }
}

async function executeCanonicalRefresh(): Promise<CanonicalContentSyncResult> {
  const config = getCanonicalContentConfig();
  const previous = getCanonicalContentCache();
  const required = isCanonicalContentRequired();
  const trustedPersistedCatalog = !required || hasCanonicalCatalogProvenance();
  const attemptedAt = new Date().toISOString();
  if (!config) {
    const error = "Canonical content API is not configured";
    return {
      success: false,
      topicsLoaded: 0,
      questionsLoaded: 0,
      errors: [error],
      notModified: false,
      staleCacheRetained: Boolean(
        trustedPersistedCatalog && previous?.lastSuccessAt && getTotalBankSize() > 0
      ),
    };
  }

  const request = async (conditional: boolean): Promise<Response> => {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${config.token}`,
    };
    if (conditional && trustedPersistedCatalog && previous?.etag) headers["If-None-Match"] = previous.etag;
    if (conditional && trustedPersistedCatalog && previous?.lastModified) {
      headers["If-Modified-Since"] = previous.lastModified;
    }

    const implementation = fetchOverride ?? fetch;
    return implementation(config.url, {
      method: "GET",
      headers,
      // The same signal remains active while the response body is consumed, so
      // a peer cannot bypass the timeout by sending headers and then stalling.
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    });
  };

  try {
    let response = await request(true);
    if (
      response.status === 304
      && (!previous?.lastSuccessAt || getTotalBankSize() === 0 || !trustedPersistedCatalog)
    ) {
      response = await request(false);
    }
    if (response.status === 304) {
      if (!previous?.lastSuccessAt || getTotalBankSize() === 0 || !trustedPersistedCatalog) {
        throw new Error("Canonical content API returned 304 without a usable persisted catalog");
      }
      const cache: PersistedCanonicalContentCache = {
        ...previous,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: attemptedAt,
        lastError: undefined,
      };
      setCanonicalContentCache(cache);
      return {
        success: true,
        topicsLoaded: getTopicSummaries().length,
        questionsLoaded: cache.questionCount,
        errors: [],
        notModified: true,
        staleCacheRetained: false,
        feedVersion: cache.feedVersion,
      };
    }
    if (!response.ok) {
      throw new Error(`Canonical content API returned HTTP ${response.status}`);
    }

    const payload = await readJsonWithinLimit(response, config.maxBytes);
    const parsed = parseFeed(payload);
    validateRevisionProgression(previous, parsed);
    const etag = response.headers.get("etag")?.trim() || undefined;
    const lastModified = response.headers.get("last-modified")?.trim() || undefined;
    const unchanged = previous?.fingerprint === parsed.fingerprint;
    const provenanceRepairRequired = required && !hasCanonicalCatalogProvenance();

    if (!unchanged || provenanceRepairRequired) {
      replaceCatalogAtomically(parsed.questions, {
        catalogSource: "canonical",
        discardNonCanonicalPools: required,
      });
    }
    const cache: PersistedCanonicalContentCache = {
      schemaVersion: 1,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      feedVersion: parsed.feedVersion,
      ...(parsed.feedUpdatedAt ? { feedUpdatedAt: parsed.feedUpdatedAt } : {}),
      fingerprint: parsed.fingerprint,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: attemptedAt,
      lastChangedAt: unchanged ? previous?.lastChangedAt : attemptedAt,
      questionCount: parsed.questions.length,
      revisions: parsed.revisions,
    };
    setCanonicalContentCache(cache);

    return {
      success: true,
      topicsLoaded: new Set(parsed.questions.map((question) => question.topicId)).size,
      questionsLoaded: parsed.questions.length,
      errors: [],
      notModified: unchanged,
      staleCacheRetained: false,
      feedVersion: parsed.feedVersion,
    };
  } catch (error) {
    const message = safeError(error);
    setCanonicalContentCache(cacheAfterFailure(message, attemptedAt));
    return {
      success: false,
      topicsLoaded: 0,
      questionsLoaded: 0,
      errors: [message],
      notModified: false,
      staleCacheRetained: Boolean(
        trustedPersistedCatalog && previous?.lastSuccessAt && getTotalBankSize() > 0
      ),
      feedVersion: previous?.feedVersion,
    };
  }
}

export function refreshCanonicalContent(): Promise<CanonicalContentSyncResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = executeCanonicalRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export function getCanonicalContentStatus(): CanonicalContentStatus {
  const cache = getCanonicalContentCache();
  const configured = getCanonicalContentConfig() !== null;
  const required = isCanonicalContentRequired();
  const ready = Boolean(
    cache?.lastSuccessAt
    && cache.questionCount > 0
    && getTotalBankSize() > 0
    && (!required || hasCanonicalCatalogProvenance())
  );
  const stale = ready && Boolean(cache?.lastError);
  const state = !configured
    ? required ? "missing_configuration" : "disabled"
    : !ready ? "never_synced"
    : stale ? "stale" : "fresh";

  return {
    source: "canonical_content_api",
    configured,
    required,
    ready,
    stale,
    state,
    questionCount: cache?.questionCount ?? 0,
    feedVersion: cache?.feedVersion,
    feedUpdatedAt: cache?.feedUpdatedAt,
    etagPresent: Boolean(cache?.etag),
    lastAttemptAt: cache?.lastAttemptAt,
    lastSuccessAt: cache?.lastSuccessAt,
    lastChangedAt: cache?.lastChangedAt,
    lastError: cache?.lastError,
  };
}

export function startCanonicalContentRefreshLoop(): boolean {
  stopCanonicalContentRefreshLoop();
  const intervalMs = getCanonicalRefreshIntervalMs();
  if (!getCanonicalContentConfig() || intervalMs === 0) return false;
  refreshTimer = setInterval(() => {
    void refreshCanonicalContent().then((result) => {
      if (!result.success) {
        console.warn("[content] Canonical refresh failed safely; retained the last validated catalog");
      }
    });
  }, intervalMs);
  refreshTimer.unref();
  return true;
}

export function stopCanonicalContentRefreshLoop(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

export function setCanonicalFetchForTests(implementation: FetchImplementation | null): void {
  fetchOverride = implementation;
}

export function resetCanonicalContentClientForTests(): void {
  stopCanonicalContentRefreshLoop();
  fetchOverride = null;
}
