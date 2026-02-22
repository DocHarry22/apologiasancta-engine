/**
 * GitHub API client for content management
 *
 * Uses GitHub REST API to read/write content files.
 * This enables the engine to commit quiz content directly to the UI repo.
 */

interface GitHubFileResult {
  sha: string;
  contentText: string;
}

interface GitHubDirectoryItem {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir";
}

interface GitHubErrorResponse {
  message: string;
  documentation_url?: string;
}

/**
 * Get a file from GitHub repository
 *
 * @returns File content and SHA, or null if file doesn't exist
 */
export async function getFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string
): Promise<GitHubFileResult | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = (await response.json()) as GitHubErrorResponse;
    throw new Error(`GitHub API error: ${error.message}`);
  }

  const data = (await response.json()) as {
    sha: string;
    content: string;
    encoding: string;
  };

  if (data.encoding !== "base64") {
    throw new Error(`Unexpected encoding: ${data.encoding}`);
  }

  const contentText = Buffer.from(data.content, "base64").toString("utf-8");

  return {
    sha: data.sha,
    contentText,
  };
}

/**
 * Create or update a file in GitHub repository
 *
 * @param sha - Required for updates, omit for new files
 * @returns The new SHA after commit
 */
export async function putFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string,
  message: string,
  contentText: string,
  sha?: string
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const body: Record<string, string> = {
    message,
    content: Buffer.from(contentText, "utf-8").toString("base64"),
    branch,
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = (await response.json()) as GitHubErrorResponse;
    throw new Error(`GitHub API error (${response.status}): ${error.message}`);
  }

  const data = (await response.json()) as {
    content: { sha: string };
  };

  return data.content.sha;
}

/**
 * Delete a file from GitHub repository
 */
export async function deleteFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string,
  message: string,
  sha: string
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      message,
      sha,
      branch,
    }),
  });

  if (!response.ok) {
    const error = (await response.json()) as GitHubErrorResponse;
    throw new Error(`GitHub API error: ${error.message}`);
  }
}

/**
 * List files/directories at a GitHub repository path
 */
export async function listDirectory(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token?: string
): Promise<GitHubDirectoryItem[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
  });

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    const error = (await response.json()) as GitHubErrorResponse;
    throw new Error(`GitHub API error: ${error.message}`);
  }

  const data = (await response.json()) as GitHubDirectoryItem[] | GitHubDirectoryItem;
  return Array.isArray(data) ? data : [data];
}

/**
 * Get GitHub configuration from environment
 */
export function getGitHubConfig(): {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  contentRoot: string;
} | null {
  const owner = process.env.GITHUB_OWNER?.trim() || process.env.GITHUB_CONTENT_OWNER?.trim();
  const repo = process.env.GITHUB_REPO?.trim() || process.env.GITHUB_CONTENT_REPO?.trim();
  const branch =
    process.env.GITHUB_BRANCH?.trim() ||
    process.env.GITHUB_CONTENT_BRANCH?.trim() ||
    "main";
  const token = process.env.GITHUB_TOKEN?.trim();
  const contentRoot =
    process.env.CONTENT_ROOT?.trim() ||
    process.env.GITHUB_CONTENT_PATH?.trim() ||
    "apologiasancta-ui/content/topics";

  if (!owner || !repo || !token) {
    return null;
  }

  return { owner, repo, branch, token, contentRoot };
}

/**
 * Check if GitHub integration is configured
 */
export function isGitHubConfigured(): boolean {
  return getGitHubConfig() !== null;
}
