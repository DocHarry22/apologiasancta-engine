/**
 * GitHub Content Fetcher
 *
 * Fetches question content from GitHub raw API.
 * Content lives in apologiasancta-ui/content/topics/
 */

import { ingestQuestions, clearBank, getTotalBankSize, getTopicSummaries } from "./bank";
import { UIQuestion } from "./validate";

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

function getRequiredConfig(): GitHubSyncConfig {
  const config = getGitHubSyncConfig();
  if (!config) {
    throw new Error("GitHub sync is not configured");
  }
  return config;
}

/**
 * Build raw GitHub URL for a file
 */
function rawUrl(path: string): string {
  const { owner, repo, branch } = getRequiredConfig();
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

/**
 * Fetch JSON from GitHub raw API
 */
async function fetchJson<T>(path: string): Promise<T> {
  const url = rawUrl(path);
  console.log(`[github] Fetching: ${url}`);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const { token } = getRequiredConfig();
  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const res = await fetch(url, { headers });

  if (!res.ok) {
    throw new Error(`GitHub fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Fetch list of files in a directory using GitHub Contents API
 */
async function listDirectory(path: string, type: "file" | "dir" = "file"): Promise<string[]> {
  const { owner, repo, branch, token } = getRequiredConfig();
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  console.log(`[github] Listing directory: ${apiUrl}`);

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ApologiaSancta-Engine",
  };

  if (token) {
    headers.Authorization = `token ${token}`;
  }

  const res = await fetch(apiUrl, { headers });

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
function convertQuestion(q: GitHubQuestion): UIQuestion {
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
    id: q.id,
    topicId: q.topicId,
    difficulty,
    question: q.question,
    choices: {
      A: q.choices.A || q.choices.a || "",
      B: q.choices.B || q.choices.b || "",
      C: q.choices.C || q.choices.c || "",
      D: q.choices.D || q.choices.d || "",
    },
    correctId: (q.correctId.toUpperCase() as "A" | "B" | "C" | "D"),
    teaching: q.teaching,
    tags: q.tags,
  };
}

/**
 * Sync all content from GitHub into the engine bank
 *
 * @returns Summary of what was synced
 */
export async function syncFromGitHub(): Promise<{
  success: boolean;
  topicsLoaded: number;
  questionsLoaded: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let questionsLoaded = 0;
  let topicsLoaded = 0;
  const config = getGitHubSyncConfig();

  console.log("[github] Starting sync from GitHub...");
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

  try {
    // Fetch index.json to get list of topics
    const index = await fetchJson<TopicIndex>(`${config.contentPath}/index.json`);
    const indexedTopicIds = index.topics.map((topic) => topic.id);

    // Also discover topic folders directly from repository
    let discoveredTopicIds: string[] = [];
    try {
      discoveredTopicIds = await listDirectory(config.contentPath, "dir");
    } catch (err) {
      const msg = `Failed to discover topic directories: ${err}`;
      console.warn(`[github] ${msg}`);
      errors.push(msg);
    }

    const topicIds = Array.from(new Set([...indexedTopicIds, ...discoveredTopicIds])).sort();
    console.log(
      `[github] Topics: index=${indexedTopicIds.length}, discovered=${discoveredTopicIds.length}, merged=${topicIds.length}`
    );

    // Clear existing bank before sync
    clearBank();

    // Fetch questions for each topic
    for (const topicId of topicIds) {
      try {
        console.log(`[github] Loading topic: ${topicId}`);

        // List question files in the topic's questions directory
        const questionFiles = await listDirectory(`${config.contentPath}/${topicId}/questions`, "file");
        const jsonFiles = questionFiles.filter((f) => f.endsWith(".json"));

        console.log(`[github] Found ${jsonFiles.length} question files in ${topicId}`);

        // Fetch each question
        const questions: UIQuestion[] = [];
        for (const file of jsonFiles) {
          try {
            const q = await fetchJson<GitHubQuestion>(
              `${config.contentPath}/${topicId}/questions/${file}`
            );
            questions.push(convertQuestion(q));
          } catch (err) {
            const msg = `Failed to fetch ${topicId}/${file}: ${err}`;
            console.error(`[github] ${msg}`);
            errors.push(msg);
          }
        }

        // Ingest questions into bank
        if (questions.length > 0) {
          const result = ingestQuestions(questions);
          questionsLoaded += result.added + result.updated;
          topicsLoaded++;
          console.log(`[github] Ingested ${result.added} new, ${result.updated} updated for ${topicId}`);
        }
      } catch (err) {
        const msg = `Failed to load topic ${topicId}: ${err}`;
        console.error(`[github] ${msg}`);
        errors.push(msg);
      }
    }

    console.log(`[github] Sync complete: ${topicsLoaded} topics, ${questionsLoaded} questions`);

    return {
      success: errors.length === 0,
      topicsLoaded,
      questionsLoaded,
      errors,
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
