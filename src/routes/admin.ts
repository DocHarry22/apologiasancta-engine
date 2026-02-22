/**
 * Admin routes - Protected by ADMIN_TOKEN header
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  start,
  pause,
  skipToNext,
  reset,
  getStatus,
  isRunning,
  startNextTopic,
  isInTopicSummary,
  getPendingNextTopic,
  cancelAutoAdvance,
  skipCurrentTopic,
  replayTopic,
  emitTopicCountdown,
} from "../engine/roundController";
import { getPlayerCount } from "../state/players";
import { getAllTopicIds, topicIdToTitle } from "../content/bank";
import {
  getTopicSequenceConfig,
  setTopicSequenceConfig,
} from "../config/topicSequence";

const router = Router();

/** Admin token from environment */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin-token";

/**
 * Middleware to verify admin token
 * Exported for use in other admin route files
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers["x-admin-token"] || req.headers["admin-token"];

  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Unauthorized - Invalid admin token" });
    return;
  }

  next();
}

// Apply admin auth to all routes
router.use(requireAdmin);

/**
 * GET /admin/status - Get controller status
 */
router.get("/status", (_req: Request, res: Response) => {
  const status = getStatus();
  res.json({
    ...status,
    playerCount: getPlayerCount(),
  });
});

/**
 * POST /admin/start - Start the controller loop
 */
router.post("/start", (_req: Request, res: Response) => {
  if (isRunning()) {
    res.status(409).json({ error: "Controller already running" });
    return;
  }

  start();
  res.json({
    success: true,
    message: "Controller started",
    status: getStatus(),
  });
});

/**
 * POST /admin/pause - Pause the controller
 */
router.post("/pause", (_req: Request, res: Response) => {
  if (!isRunning()) {
    res.status(409).json({ error: "Controller not running" });
    return;
  }

  pause();
  res.json({
    success: true,
    message: "Controller paused",
    status: getStatus(),
  });
});

/**
 * POST /admin/next - Skip to next question
 */
router.post("/next", (_req: Request, res: Response) => {
  skipToNext();
  res.json({
    success: true,
    message: "Skipped to next question",
    status: getStatus(),
  });
});

/**
 * POST /admin/reset - Reset all scores and restart
 */
router.post("/reset", (_req: Request, res: Response) => {
  reset();
  res.json({
    success: true,
    message: "Quiz reset",
    status: getStatus(),
  });
});

// ============== Topic Management Routes ==============

/**
 * POST /admin/topic/next - Start the next topic in sequence
 * 
 * Body (optional):
 *   topicId?: string - Specific topic to start (overrides sequence)
 */
router.post("/topic/next", (req: Request, res: Response) => {
  const topicIdRaw = req.body?.topicId;
  const topicId = typeof topicIdRaw === "string" ? topicIdRaw : undefined;
  
  // If specific topicId provided, use it
  if (topicId) {
    const availableTopics = getAllTopicIds();
    if (!availableTopics.includes(topicId)) {
      return res.status(400).json({
        error: `Topic not found: ${topicId}`,
        availableTopics,
      });
    }
    
    startNextTopic(topicId);
    return res.json({
      success: true,
      message: `Started topic: ${topicId}`,
      topicTitle: topicIdToTitle(topicId),
      status: getStatus(),
    });
  }
  
  // Otherwise, get the pending next topic from sequence
  const pendingTopicId = getPendingNextTopic();
  
  if (!pendingTopicId) {
    return res.status(400).json({
      error: "No pending next topic. Set topicId in body or use /admin/topic/start/:topicId",
    });
  }
  
  startNextTopic(pendingTopicId);
  return res.json({
    success: true,
    message: `Started next topic: ${pendingTopicId}`,
    topicTitle: topicIdToTitle(pendingTopicId),
    status: getStatus(),
  });
});

/**
 * POST /admin/topic/start/:topicId - Start a specific topic
 */
router.post("/topic/start/:topicId", (req: Request<{ topicId: string }>, res: Response) => {
  const { topicId } = req.params;
  
  const availableTopics = getAllTopicIds();
  if (!availableTopics.includes(topicId)) {
    return res.status(400).json({
      error: `Topic not found: ${topicId}`,
      availableTopics,
    });
  }
  
  startNextTopic(topicId);
  return res.json({
    success: true,
    message: `Started topic: ${topicId}`,
    topicTitle: topicIdToTitle(topicId),
    status: getStatus(),
  });
});

/**
 * POST /admin/topic/cancel-auto - Cancel auto-advance to next topic
 */
router.post("/topic/cancel-auto", (_req: Request, res: Response) => {
  if (!isInTopicSummary()) {
    return res.status(400).json({
      error: "Not in topic summary mode",
    });
  }
  
  cancelAutoAdvance();
  return res.json({
    success: true,
    message: "Auto-advance cancelled",
    status: getStatus(),
  });
});

/**
 * POST /admin/topic/skip - Skip current topic and move to next
 * Resets scores/streaks and starts next topic immediately
 */
router.post("/topic/skip", (_req: Request, res: Response) => {
  const result = skipCurrentTopic();
  
  if (!result.success || !result.nextTopicId) {
    return res.status(400).json({
      error: "Cannot skip - no next topic available",
      availableTopics: getAllTopicIds(),
    });
  }
  
  return res.json({
    success: true,
    message: `Skipped to topic: ${result.nextTopicId}`,
    topicId: result.nextTopicId,
    topicTitle: topicIdToTitle(result.nextTopicId),
    status: getStatus(),
  });
});

/**
 * POST /admin/topic/replay - Replay current topic from beginning
 * Resets scores/streaks and restarts same topic
 */
router.post("/topic/replay", (_req: Request, res: Response) => {
  const result = replayTopic();
  
  if (!result.success || !result.topicId) {
    return res.status(400).json({
      error: "Cannot replay - no active topic",
    });
  }
  
  return res.json({
    success: true,
    message: `Replaying topic: ${result.topicId}`,
    topicId: result.topicId,
    topicTitle: topicIdToTitle(result.topicId),
    status: getStatus(),
  });
});

/**
 * POST /admin/topic/countdown - Start countdown before beginning a topic
 * 
 * Body:
 *   countdownSeconds: number (default: 10)
 *   topicId?: string (optional, uses pending/current if not specified)
 */
router.post("/topic/countdown", (req: Request, res: Response) => {
  const countdownSecondsRaw = req.body?.countdownSeconds;
  const countdownSeconds = typeof countdownSecondsRaw === "number" 
    ? Math.max(1, Math.min(60, countdownSecondsRaw))  // Clamp 1-60
    : 10;
  
  const topicIdRaw = req.body?.topicId;
  let topicId = typeof topicIdRaw === "string" ? topicIdRaw : undefined;
  
  // If no topicId specified, try pending next topic or current topic
  if (!topicId) {
    topicId = getPendingNextTopic() || undefined;
  }
  
  if (!topicId) {
    const availableTopics = getAllTopicIds();
    topicId = availableTopics[0];
  }
  
  if (!topicId) {
    return res.status(400).json({
      error: "No topic available for countdown",
    });
  }
  
  // Validate the topicId exists
  const availableTopics = getAllTopicIds();
  if (!availableTopics.includes(topicId)) {
    return res.status(400).json({
      error: `Topic not found: ${topicId}`,
      availableTopics,
    });
  }
  
  emitTopicCountdown(topicId, countdownSeconds);
  
  return res.json({
    success: true,
    message: `Starting ${countdownSeconds}s countdown for topic: ${topicId}`,
    topicId,
    topicTitle: topicIdToTitle(topicId),
    countdownSeconds,
    status: getStatus(),
  });
});

/**
 * GET /admin/topic/sequence - Get topic sequence configuration
 */
router.get("/topic/sequence", (_req: Request, res: Response) => {
  const config = getTopicSequenceConfig();
  const availableTopics = getAllTopicIds();
  
  return res.json({
    config,
    availableTopics,
    availableTopicsWithTitles: availableTopics.map((id) => ({
      id,
      title: topicIdToTitle(id),
    })),
  });
});

/**
 * POST /admin/topic/sequence - Update topic sequence configuration
 * 
 * Body:
 *   topicSequence?: string[] - Ordered list of topic IDs
 *   topicSummaryDisplayTimeMs?: number - Summary display time
 *   autoAdvance?: boolean - Auto-advance to next topic
 *   loopOnComplete?: boolean - Loop back to first topic
 */
router.post("/topic/sequence", (req: Request, res: Response) => {
  const update = req.body || {};
  
  // Validate topicSequence if provided
  if (update.topicSequence) {
    const availableTopics = getAllTopicIds();
    const invalidTopics = update.topicSequence.filter(
      (id: string) => !availableTopics.includes(id)
    );
    
    if (invalidTopics.length > 0) {
      return res.status(400).json({
        error: "Some topics not found",
        invalidTopics,
        availableTopics,
      });
    }
  }
  
  const newConfig = setTopicSequenceConfig(update);
  return res.json({
    success: true,
    config: newConfig,
  });
});

export default router;
