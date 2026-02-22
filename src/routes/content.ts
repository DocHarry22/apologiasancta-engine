/**
 * Content Management Admin Routes
 *
 * Endpoints for importing questions and managing quiz sets.
 */

import { Router, Request, Response } from "express";
import { requireAdmin } from "./admin";
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
import { validateQuestionBatch, UIQuestion } from "../content/validate";
import {
  getFile,
  putFile,
  getGitHubConfig,
  isGitHubConfigured,
} from "../github/client";
import {
  topicsIndexPath,
  topicManifestPath,
  topicQuestionPath,
} from "../github/paths";
import { inferPrefix, nextId } from "../content/id";

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

      // Optionally commit to GitHub
      let committed = false;
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
        bankSize: getTotalBankSize(),
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
    bankSize: 0,
    activePoolSize: 0,
  });
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
  }
}

export default router;
