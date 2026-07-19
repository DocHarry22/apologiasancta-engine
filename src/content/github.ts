/**
 * GitHub Content Fetcher
 *
 * Fetches question content from GitHub raw API.
 * Content lives in apologiasancta-ui/content/topics/
 */

import { getTotalBankSize, getTopicSummaries, replaceCatalogAtomically } from "./bank";
import { UIQuestion, validateQuestion } from "./validate";
import { isCanonicalContentRequired } from "./canonical";

export interface GitHubSyncConfig {
  owner: string;
  repo: string;
  branch: string;
  token?: string;
  contentPath: string;
}

function getEnvTrimmed(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function getGitHubSyncConfig(): GitHubSyncConfig | null {
  const owner = getEnvTrimmed("GITHUB_CONTENT_OWNER") ?? getEnvTrimmed("GITHUB_OWNER");
  const repo = getEnvTrimmed("GITHUB_CONTENT_REPO") ?? getEnvTrimmed("GITHUB_REPO");
  const branch =
    getEnvTrimmed("GITHUB_CONTENT_BRANCH") ??
    getEnvTrimmed("GITHUB_BRANCH") ??
    "main";
  const token = getEnvTrimmed("GITHUB_TOKEN");
  const contentPath =
    getEnvTrimmed("GITHUB_CONTENT_PATH") ??
    getEnvTrimmed("CONTENT_ROOT") ??
    "apologiasancta-ui/content/topics";

  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    branch,
    token,
    contentPath,
  };
}

/**
 * Build raw GitHub URL for a file
 */
function rawUrl(config: GitHubSyncConfig, path: string): string {
  const { owner, repo, branch } = config;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

/**
 * Fetch JSON from GitHub raw API
 */
async function fetchJson<T>(config: GitHubSyncConfig, path: string, signal: AbortSignal): Promise<T> {
  const url = rawUrl(config, path);
  console.log(`[github] Fetching: ${url}`);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const { token } = config;
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const res = await fetch(url, { headers, signal });

  if (!res.ok) {
    throw new Error(`GitHub fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Fetch list of files in a directory using GitHub Contents API
 */
async function listDirectory(
  config: GitHubSyncConfig,
  path: string,
  type: "file" | "dir",
  signal: AbortSignal
): Promise<string[]> {
  const { owner, repo, branch, token } = config;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  console.log(`[github] Listing directory: ${apiUrl}`);

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ApologiaSancta-Engine",
  };

  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const res = await fetch(apiUrl, { headers, signal });

  if (!res.ok) {
    throw new Error(`GitHub API failed: ${res.status} ${res.statusText}`);
  }

  const items = (await res.json()) as Array<{ name: string; type: string }>;
  return items.filter((item) => item.type === type).map((item) => item.name);
}

interface TopicIndex {
  topics: Array<{
    id: string;
    title: string;
    description: string;
    questionCount: number;
    tags: string[];
  }>;
}

export interface GitHubContentSource {
  fetchJson<T>(path: string): Promise<T>;
  listDirectory(path: string, type: "file" | "dir"): Promise<string[]>;
}

export interface GitHubSyncResult {
  success: boolean;
  topicsLoaded: number;
  questionsLoaded: number;
  errors: string[];
}

interface GitHubQuestion {
  id: string;
  topicId: string;
  difficulty: number | "easy" | "medium" | "hard";
  question: string;
  choices: Record<string, string>;
  correctId: string;
  teaching: {
    title: string;
    body: string;
    refs: string[];
  };
  tags: string[];
}

/**
 * Convert GitHub question format to UIQuestion format
 */
function convertQuestion(value: unknown): UIQuestion {
  const q = (value && typeof value === "object" ? value : {}) as Partial<GitHubQuestion>;
  const choices = q.choices ?? {};
  const teaching = q.teaching ?? { title: "", body: "", refs: [] };
  // Normalize difficulty to UIQuestion format
  let difficulty: UIQuestion["difficulty"];
  if (typeof q.difficulty === "string") {
    difficulty = q.difficulty as "easy" | "medium" | "hard";
  } else if (typeof q.difficulty === "number") {
    // Clamp to valid range
    const clamped = Math.max(1, Math.min(5, Math.round(q.difficulty)));
    difficulty = clamped as 1 | 2 | 3 | 4 | 5;
  }

  return {
    id: q.id as string,
    topicId: q.topicId as string,
    difficulty,
    question: q.question as string,
    choices: {
      A: choices.A || choices.a || "",
      B: choices.B || choices.b || "",
      C: choices.C || choices.c || "",
      D: choices.D || choices.d || "",
    },
    correctId: (typeof q.correctId === "string" ? q.correctId.toUpperCase() : "") as "A" | "B" | "C" | "D",
    teaching,
    tags: q.tags,
  };
}

/**
 * Sync all content from GitHub into the engine bank
 *
 * @returns Summary of what was synced
 */
export async function syncCatalogFromSource(
  source: GitHubContentSource,
  contentPath: string
): Promise<GitHubSyncResult> {
  const errors: string[] = [];
  const candidateQuestions: UIQuestion[] = [];
  const candidateIds = new Set<string>();

  console.log("[github] Starting sync from GitHub...");

  try {
    // Fetch index.json to get list of topics
    const index = await source.fetchJson<TopicIndex>(`${contentPath}/index.json`);
    const indexedTopicIds = index.topics.map((topic) => topic.id);

    // Also discover topic folders directly from repository
    let discoveredTopicIds: string[] = [];
    try {
      discoveredTopicIds = await source.listDirectory(contentPath, "dir");
    } catch (err) {
      const msg = `Failed to discover topic directories: ${err}`;
      console.warn(`[github] ${msg}`);
      errors.push(msg);
    }

    const topicIds = Array.from(new Set([...indexedTopicIds, ...discoveredTopicIds])).sort();
    console.log(
      `[github] Topics: index=${indexedTopicIds.length}, discovered=${discoveredTopicIds.length}, merged=${topicIds.length}`
    );

    // Fetch questions for each topic
    for (const topicId of topicIds) {
      try {
        console.log(`[github] Loading topic: ${topicId}`);

        // List question files in the topic's questions directory
        const questionFiles = await source.listDirectory(`${contentPath}/${topicId}/questions`, "file");
        const jsonFiles = questionFiles.filter((f) => f.endsWith(".json"));

        console.log(`[github] Found ${jsonFiles.length} question files in ${topicId}`);

        // Fetch each question
        const questions: UIQuestion[] = [];
        for (const file of jsonFiles) {
          try {
            const rawQuestion = await source.fetchJson<unknown>(
              `${contentPath}/${topicId}/questions/${file}`
            );
            const question = convertQuestion(rawQuestion);
            const validation = validateQuestion(question);
            if (!validation.valid) {
              throw new Error(validation.errors.join("; "));
            }
            if (candidateIds.has(question.id)) {
              throw new Error(`Duplicate question id: ${question.id}`);
            }
            candidateIds.add(question.id);
            questions.push(question);
          } catch (err) {
            const msg = `Failed to fetch ${topicId}/${file}: ${err}`;
            console.error(`[github] ${msg}`);
            errors.push(msg);
          }
        }

        // Stage questions only. The live catalog remains untouched until every
        // fetch and validation has succeeded.
        if (questions.length > 0) {
          candidateQuestions.push(...questions);
          console.log(`[github] Staged ${questions.length} questions for ${topicId}`);
        }
      } catch (err) {
        const msg = `Failed to load topic ${topicId}: ${err}`;
        console.error(`[github] ${msg}`);
        errors.push(msg);
      }
    }

    if (errors.length > 0) {
      console.warn(`[github] Sync rejected; retaining prior catalog (${errors.length} error(s))`);
      return {
        success: false,
        topicsLoaded: 0,
        questionsLoaded: 0,
        errors,
      };
    }

    if (candidateQuestions.length === 0) {
      const error = "GitHub sync produced an empty catalog; retaining prior catalog";
      console.warn(`[github] ${error}`);
      return {
        success: false,
        topicsLoaded: 0,
        questionsLoaded: 0,
        errors: [error],
      };
    }

    const replacement = replaceCatalogAtomically(candidateQuestions);
    const topicsLoaded = new Set(candidateQuestions.map((question) => question.topicId)).size;
    const questionsLoaded = candidateQuestions.length;
    console.log(
      `[github] Sync committed atomically: ${topicsLoaded} topics, ${questionsLoaded} questions `
      + `(${replacement.added} added, ${replacement.updated} updated, ${replacement.removed} removed)`
    );

    return {
      success: true,
      topicsLoaded,
      questionsLoaded,
      errors: [],
    };
  } catch (err) {
    const msg = `Failed to fetch index.json: ${err}`;
    console.error(`[github] ${msg}`);
    return {
      success: false,
      topicsLoaded: 0,
      questionsLoaded: 0,
      errors: [msg],
    };
  }
}

function resolveSyncTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.GITHUB_SYNC_TIMEOUT_MS ?? "60000", 10);
  if (!Number.isFinite(parsed)) return 60_000;
  return Math.max(5_000, Math.min(300_000, parsed));
}

/**
 * Fetch and atomically replace the catalog. A timeout, fetch failure, or
 * validation failure leaves the restored/live catalog unchanged.
 */
export async function syncFromGitHub(): Promise<GitHubSyncResult> {
  if (isCanonicalContentRequired()) {
    return {
      success: false,
      topicsLoaded: 0,
      questionsLoaded: 0,
      errors: ["GitHub catalog sync is disabled while canonical content is required"],
    };
  }
  const config = getGitHubSyncConfig();
  if (!config) {
    return {
      success: false,
      topicsLoaded: 0,
      questionsLoaded: 0,
      errors: [
        "GitHub sync is not configured. Set GITHUB_OWNER/GITHUB_REPO (or GITHUB_CONTENT_OWNER/GITHUB_CONTENT_REPO).",
      ],
    };
  }

  console.log(
    `[github] Repo: ${config.owner}/${config.repo} (branch: ${config.branch}, path: ${config.contentPath})`
  );

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), resolveSyncTimeoutMs());
  timeout.unref();
  const source: GitHubContentSource = {
    fetchJson: <T>(path: string) => fetchJson<T>(config, path, abortController.signal),
    listDirectory: (path, type) => listDirectory(config, path, type, abortController.signal),
  };

  try {
    return await syncCatalogFromSource(source, config.contentPath);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get current sync status
 */
export function getSyncStatus(): {
  bankSize: number;
  topics: Array<{ topicId: string; count: number }>;
  repo: string;
  branch: string;
} {
  const config = getGitHubSyncConfig();
  return {
    bankSize: getTotalBankSize(),
    topics: getTopicSummaries(),
    repo: config ? `${config.owner}/${config.repo}` : "(not configured)",
    branch: config?.branch ?? "(n/a)",
  };
}
