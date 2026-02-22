/**
 * Content Management Admin Routes
 *
 * Endpoints for importing questions and managing quiz sets.
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "./admin";
import { onPoolUpdated } from "../engine/roundController";
import {
  ingestQuestions,
  getTopicSummaries,
  setActivePool,
  getActivePoolSize,
  getTotalBankSize,
  getAllTopicIds,
  clearBank,
  isBankEmpty,
} from "../content/bank";
import { clearAllAnswers } from "../state/players";
import { validateQuestionBatch, UIQuestion } from "../content/validate";
import {
  getFile,
  putFile,
  deleteFile,
  listDirectory,
  getGitHubConfig,
  isGitHubConfigured,
} from "../github/client";
import {
  topicsIndexPath,
  topicMetaPath,
  topicManifestPath,
  topicQuestionPath,
  topicQuestionsDir,
} from "../github/paths";
import { inferPrefix, nextId } from "../content/id";
import { syncFromGitHub, getSyncStatus } from "../content/github";

const router = Router();

/**
 * POST /admin/content/import
 *
 * Import questions into the content bank and optionally commit to GitHub.
 *
 * Body:
 *   questions: UIQuestion[] - Array of validated questions
 *   commitToGitHub?: boolean - Whether to persist to GitHub (default: false)
 *   commitMessage?: string - Custom commit message
 *
 * Response:
 *   added: number - Questions newly added
 *   updated: number - Existing questions updated
 *   committed: boolean - Whether changes were committed to GitHub
 *   errors?: Array<{ index: number; errors: string[] }> - Validation errors
 */
router.post(
  "/content/import",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const {
        questions = [],
        commitToGitHub = false,
        commitMessage = "Add quiz questions via engine",
      } = req.body;

      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({
          error: "questions must be a non-empty array",
        });
      }

      // Validate all questions
      const { valid, errors } = validateQuestionBatch(questions);

      if (errors.length > 0) {
        return res.status(400).json({
          error: "Some questions failed validation",
          validCount: valid.length,
          invalidCount: errors.length,
          errors,
        });
      }

      // Ingest valid questions into the bank
      const result = ingestQuestions(valid);
      const activePoolSize = setActivePool([], true);

      // Optionally commit to GitHub
      let committed = false;
      let commitTarget:
        | {
            owner: string;
            repo: string;
            branch: string;
            contentRoot: string;
          }
        | undefined;
      if (commitToGitHub) {
        const config = getGitHubConfig();
        if (!config) {
          return res.status(500).json({
            error: "GitHub not configured. Set GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN.",
            added: result.added,
            updated: result.updated,
            committed: false,
          });
        }

        try {
          await commitQuestionsToGitHub(valid, config, commitMessage);
          committed = true;
          commitTarget = {
            owner: config.owner,
            repo: config.repo,
            branch: config.branch,
            contentRoot: config.contentRoot,
          };
        } catch (err) {
          console.error("GitHub commit failed:", err);
          return res.status(500).json({
            error: `GitHub commit failed: ${(err as Error).message}`,
            added: result.added,
            updated: result.updated,
            committed: false,
          });
        }
      }

      return res.json({
        added: result.added,
        updated: result.updated,
        ids: result.ids,
        committed,
        commitTarget,
        bankSize: getTotalBankSize(),
        activePoolSize,
      });
    } catch (error) {
      console.error("Content import error:", error);
      return res.status(500).json({
        error: `Import failed: ${(error as Error).message}`,
      });
    }
  }
);

/**
 * POST /admin/quiz/set
 *
 * Configure the active quiz question set.
 *
 * Body:
 *   topicIds?: string[] - Topics to include (empty = all)
 *   shuffle?: boolean - Randomize order (default: true)
 *
 * Response:
 *   poolSize: number - Questions in active pool
 *   topicIds: string[] - Selected topics
 */
router.post("/quiz/set", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { topicIds = [], shuffle = true } = req.body;

    if (!Array.isArray(topicIds)) {
      return res.status(400).json({
        error: "topicIds must be an array",
      });
    }

    // Validate topic IDs exist in bank
    const availableTopics = getAllTopicIds();
    const invalidTopics = topicIds.filter(
      (id: string) => !availableTopics.includes(id)
    );

    if (invalidTopics.length > 0 && topicIds.length > 0) {
      return res.status(400).json({
        error: "Some topics not found in bank",
        invalidTopics,
        availableTopics,
      });
    }

    const poolSize = setActivePool(topicIds, shuffle);

    if (poolSize === 0) {
      return res.status(400).json({
        error: "No questions available for selected topics",
        topicIds,
        bankSize: getTotalBankSize(),
      });
    }

    clearAllAnswers();
    onPoolUpdated();

    return res.json({
      poolSize,
      topicIds: topicIds.length > 0 ? topicIds : availableTopics,
      shuffle,
    });
  } catch (error) {
    console.error("Quiz set error:", error);
    return res.status(500).json({
      error: `Failed to set quiz: ${(error as Error).message}`,
    });
  }
});

/**
 * GET /admin/content/status
 *
 * Get current content bank and active pool status.
 */
router.get("/content/status", requireAdmin, (req: Request, res: Response) => {
  const topics = getTopicSummaries();

  return res.json({
    bankSize: getTotalBankSize(),
    activePoolSize: getActivePoolSize(),
    topicCount: topics.length,
    topics,
    gitHubConfigured: isGitHubConfigured(),
  });
});

/**
 * POST /admin/content/clear
 *
 * Clear all questions from the content bank.
 */
router.post("/content/clear", requireAdmin, (req: Request, res: Response) => {
  clearBank();
  return res.json({
    success: true,
    scope: "engine-bank-only",
    bankSize: 0,
    activePoolSize: 0,
  });
});

/**
 * POST /admin/content/github/clear
 *
 * Danger action: delete question files from GitHub content store.
 * This does NOT run automatically when clearing local engine bank.
 */
router.post("/content/github/clear", requireAdmin, async (_req: Request, res: Response) => {
  const config = getGitHubConfig();
  if (!config) {
    return res.status(400).json({
      error: "GitHub not configured. Set GITHUB_OWNER, GITHUB_REPO, and GITHUB_TOKEN.",
    });
  }

  try {
    const result = await clearQuestionsFromGitHub(config);
    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("GitHub clear failed:", error);
    return res.status(500).json({
      error: `GitHub clear failed: ${(error as Error).message}`,
    });
  }
});

/**
 * POST /admin/content/sync
 *
 * Sync content from GitHub repository into the engine bank.
 * This fetches all topics and questions from the configured GitHub repo.
 */
router.post("/content/sync", requireAdmin, async (req: Request, res: Response) => {
  console.log("[sync] Admin triggered GitHub sync");

  try {
    const result = await syncFromGitHub();

    if (!result.success) {
      return res.status(500).json({
        error: "Sync completed with errors",
        ...result,
      });
    }

    const activePoolSize = setActivePool([], true);
    clearAllAnswers();
    onPoolUpdated();

    return res.json({
      message: "Content synced from GitHub",
      activePoolSize,
      ...result,
    });
  } catch (error) {
    console.error("[sync] Sync error:", error);
    return res.status(500).json({
      error: `Sync failed: ${(error as Error).message}`,
    });
  }
});

/**
 * GET /admin/content/sync/status
 *
 * Get current sync status and GitHub configuration.
 */
router.get("/content/sync/status", requireAdmin, (req: Request, res: Response) => {
  const status = getSyncStatus();
  return res.json(status);
});

/**
 * Helper: Commit questions to GitHub
 */
async function commitQuestionsToGitHub(
  questions: UIQuestion[],
  config: {
    owner: string;
    repo: string;
    branch: string;
    token: string;
    contentRoot: string;
  },
  message: string
): Promise<void> {
  const { owner, repo, branch, token, contentRoot } = config;

  const toTitle = (topicId: string): string =>
    topicId
      .replace(/[_-]+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());

  // Load index.json (create if missing)
  const indexPath = topicsIndexPath(contentRoot);
  let indexSha: string | undefined;
  let indexData: {
    topics: Array<{
      id: string;
      title: string;
      description: string;
      questionCount: number;
      tags: string[];
    }>;
  } = { topics: [] };

  try {
    const indexFile = await getFile(owner, repo, indexPath, branch, token);
    if (indexFile) {
      indexData = JSON.parse(indexFile.contentText);
      indexSha = indexFile.sha;
    }
  } catch {
    // index will be created
  }

  const topicMap = new Map(indexData.topics.map((topic) => [topic.id, topic]));
  let indexChanged = false;

  // Group questions by topic
  const byTopic = new Map<string, UIQuestion[]>();
  for (const q of questions) {
    if (!byTopic.has(q.topicId)) {
      byTopic.set(q.topicId, []);
    }
    byTopic.get(q.topicId)!.push(q);
  }

  // Process each topic
  for (const [topicId, topicQuestions] of byTopic.entries()) {
    // Get or create manifest for this topic
    const manifestPath = topicManifestPath(contentRoot, topicId);
    let manifestData: { questionIds: string[] } = { questionIds: [] };
    let manifestSha: string | undefined;

    try {
      const existing = await getFile(owner, repo, manifestPath, branch, token);
      if (existing) {
        manifestData = JSON.parse(existing.contentText);
        manifestSha = existing.sha;
      }
    } catch {
      // Manifest doesn't exist yet, will create
    }

    const existingIds = new Set(manifestData.questionIds);
    const newIds: string[] = [];

    // Commit each question
    for (const q of topicQuestions) {
      // Auto-generate ID if needed
      if (!q.id || existingIds.has(q.id)) {
        const prefix = inferPrefix(topicId);
        q.id = nextId(prefix, [...existingIds, ...newIds]);
      }

      const questionPath = topicQuestionPath(contentRoot, topicId, q.id);
      const questionContent = JSON.stringify(q, null, 2);

      // Try to get existing file SHA
      let questionSha: string | undefined;
      try {
        const existing = await getFile(owner, repo, questionPath, branch, token);
        if (existing) {
          questionSha = existing.sha;
        }
      } catch {
        // File doesn't exist
      }

      await putFile(
        owner,
        repo,
        questionPath,
        branch,
        token,
        message,
        questionContent,
        questionSha
      );

      if (!existingIds.has(q.id)) {
        newIds.push(q.id);
      }
    }

    // Update manifest with new IDs
    if (newIds.length > 0) {
      manifestData.questionIds = [...manifestData.questionIds, ...newIds];
      await putFile(
        owner,
        repo,
        manifestPath,
        branch,
        token,
        message,
        JSON.stringify(manifestData, null, 2),
        manifestSha
      );
    }

    // Ensure topic appears in index.json
    if (!topicMap.has(topicId)) {
      topicMap.set(topicId, {
        id: topicId,
        title: toTitle(topicId),
        description: `Auto-created topic for ${toTitle(topicId)}.`,
        questionCount: manifestData.questionIds.length,
        tags: [],
      });
      indexChanged = true;
    } else {
      const existing = topicMap.get(topicId)!;
      if (existing.questionCount !== manifestData.questionIds.length) {
        existing.questionCount = manifestData.questionIds.length;
        indexChanged = true;
      }
    }

    // Ensure meta.json exists for new topics and keep count current
    const metaPath = topicMetaPath(contentRoot, topicId);
    const existingMeta = await getFile(owner, repo, metaPath, branch, token);
    const metaPayload = existingMeta
      ? {
          ...JSON.parse(existingMeta.contentText),
          questionCount: manifestData.questionIds.length,
        }
      : {
          id: topicId,
          title: toTitle(topicId),
          description: `Auto-created topic for ${toTitle(topicId)}.`,
          difficultyRange: [1, 5],
          tags: [] as string[],
          questionCount: manifestData.questionIds.length,
        };

    await putFile(
      owner,
      repo,
      metaPath,
      branch,
      token,
      message,
      JSON.stringify(metaPayload, null, 2),
      existingMeta?.sha
    );
  }

  // Persist updated index if any topic was added/changed
  if (indexChanged) {
    const topics = Array.from(topicMap.values()).sort((a, b) => a.id.localeCompare(b.id));
    await putFile(
      owner,
      repo,
      indexPath,
      branch,
      token,
      message,
      JSON.stringify({ topics }, null, 2),
      indexSha
    );
  }
}

/**
 * Helper: Delete all question JSON files and manifests from GitHub.
 * Leaves index/meta files intact so topic structure remains.
 */
async function clearQuestionsFromGitHub(config: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  contentRoot: string;
}): Promise<{ deletedQuestions: number; deletedManifests: number; topicsProcessed: number }> {
  const { owner, repo, branch, token, contentRoot } = config;

  const indexPath = topicsIndexPath(contentRoot);
  const indexFile = await getFile(owner, repo, indexPath, branch, token);
  if (!indexFile) {
    throw new Error(`Index file not found at ${indexPath}`);
  }

  const index = JSON.parse(indexFile.contentText) as {
    topics?: Array<{ id: string }>;
  };

  const topics = index.topics ?? [];
  let deletedQuestions = 0;
  let deletedManifests = 0;

  for (const topic of topics) {
    const topicId = topic.id;
    const manifestPath = topicManifestPath(contentRoot, topicId);
    const manifest = await getFile(owner, repo, manifestPath, branch, token);

    if (manifest) {
      const manifestData = JSON.parse(manifest.contentText) as { questionIds?: string[] };
      const questionIds = manifestData.questionIds ?? [];

      for (const questionId of questionIds) {
        const questionPath = topicQuestionPath(contentRoot, topicId, questionId);
        const questionFile = await getFile(owner, repo, questionPath, branch, token);
        if (!questionFile) {
          continue;
        }

        await deleteFile(
          owner,
          repo,
          questionPath,
          branch,
          token,
          `Delete question ${questionId} from ${topicId}`,
          questionFile.sha
        );
        deletedQuestions++;
      }

      await deleteFile(
        owner,
        repo,
        manifestPath,
        branch,
        token,
        `Delete manifest for ${topicId}`,
        manifest.sha
      );
      deletedManifests++;
      continue;
    }

    const questionDir = topicQuestionsDir(contentRoot, topicId);
    const files = await listDirectory(owner, repo, questionDir, branch, token);
    for (const file of files) {
      if (file.type !== "file" || !file.name.endsWith(".json")) {
        continue;
      }

      await deleteFile(
        owner,
        repo,
        file.path,
        branch,
        token,
        `Delete question ${file.name} from ${topicId}`,
        file.sha
      );
      deletedQuestions++;
    }
  }

  return {
    deletedQuestions,
    deletedManifests,
    topicsProcessed: topics.length,
  };
}

export default router;
