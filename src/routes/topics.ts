/**
 * Public Topics Routes
 *
 * Unauthenticated endpoints for browsing available content.
 * Used by the library page to display topics.
 */

import { Router, Request, Response } from "express";
import {
  getTopicSummaries,
  getTotalBankSize,
  getTopicQuestions,
} from "../content/bank";

const router = Router();

/**
 * GET /topics
 *
 * List all topics with question counts.
 * Public endpoint - no authentication required.
 */
router.get("/", (req: Request, res: Response) => {
  console.log("[topics] GET /topics called");
  const summaries = getTopicSummaries();
  const totalSize = getTotalBankSize();
  console.log(`[topics] Bank has ${totalSize} questions, ${summaries.length} topics`);
  console.log("[topics] Topics:", summaries.map(s => `${s.topicId}(${s.count})`).join(", ") || "(none)");

  // Enrich with display metadata
  const topics = summaries.map((summary) => {
    // Generate title from topicId
    const title = summary.topicId
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    return {
      id: summary.topicId,
      title,
      questionCount: summary.count,
    };
  });

  return res.json({
    topics,
    totalQuestions: getTotalBankSize(),
  });
});

/**
 * GET /topics/:topicId
 *
 * Get topic details and question list (without answers).
 * Public endpoint - no authentication required.
 */
router.get("/:topicId", (req: Request, res: Response) => {
  const topicId = req.params.topicId as string;
  const questions = getTopicQuestions(topicId);

  if (questions.length === 0) {
    return res.status(404).json({
      error: "Topic not found or has no questions",
      topicId,
    });
  }

  // Return questions without correct answers
  const safeQuestions = questions.map((entry) => ({
    id: entry.id,
    text: entry.engineFormat.text,
    themeTitle: entry.engineFormat.themeTitle,
    difficulty: entry.difficulty,
    choices: entry.engineFormat.choices.map((c) => ({
      id: c.id,
      label: c.label,
      text: c.text,
    })),
    // Exclude correctId and teaching (those are for reveal phase only)
  }));

  const title = topicId
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c: string) => c.toUpperCase());

  return res.json({
    id: topicId,
    title,
    questionCount: questions.length,
    questions: safeQuestions,
  });
});

export default router;
