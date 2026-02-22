/**
 * Admin YouTube Routes
 * 
 * Admin endpoints for managing YouTube Live Chat integration.
 * All routes are prefixed with /admin/youtube
 */

import { Router, Request, Response, NextFunction } from "express";
import { createPoller, getPoller, destroyPoller } from "../youtube/poller";

const router = Router();

/** Admin token from environment */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin-token";

/**
 * Middleware to verify admin token
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers["x-admin-token"] || req.headers["admin-token"];

  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Unauthorized - Invalid admin token" });
    return;
  }

  next();
}

// Apply admin auth to all routes
router.use(requireAdmin);

/** Get YouTube API key from environment */
function getApiKey(): string | null {
  return process.env.YOUTUBE_API_KEY || null;
}

/**
 * POST /admin/youtube/connect
 * 
 * Connect to a YouTube live stream
 * Body: { videoId?: string, liveChatId?: string }
 * 
 * At least one of videoId or liveChatId must be provided.
 * If only videoId is provided, liveChatId will be resolved from the API.
 */
router.post("/connect", async (req: Request, res: Response) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      res.status(500).json({
        error: "YouTube API key not configured",
        hint: "Set YOUTUBE_API_KEY environment variable",
      });
      return;
    }

    const { videoId, liveChatId } = req.body as {
      videoId?: string;
      liveChatId?: string;
    };

    // Use environment fallbacks
    const resolvedVideoId = videoId || process.env.YOUTUBE_VIDEO_ID;
    const resolvedLiveChatId = liveChatId || process.env.YOUTUBE_LIVECHAT_ID;

    if (!resolvedVideoId && !resolvedLiveChatId) {
      res.status(400).json({
        error: "Missing required parameter",
        message: "Provide videoId or liveChatId in request body or environment",
      });
      return;
    }

    // Create and connect poller
    const poller = createPoller(apiKey);
    await poller.connect(resolvedVideoId, resolvedLiveChatId);

    res.json({
      success: true,
      message: "Connected to YouTube Live Chat",
      status: poller.getStatus(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Admin YouTube] Connect failed: ${message}`);
    res.status(500).json({
      error: "Connection failed",
      message,
    });
  }
});

/**
 * POST /admin/youtube/disconnect
 * 
 * Disconnect from YouTube live chat
 */
router.post("/disconnect", (_req: Request, res: Response) => {
  const poller = getPoller();
  
  if (!poller) {
    res.json({
      success: true,
      message: "No active connection",
    });
    return;
  }

  destroyPoller();

  res.json({
    success: true,
    message: "Disconnected from YouTube Live Chat",
  });
});

/**
 * GET /admin/youtube/status
 * 
 * Get current YouTube connection status
 */
router.get("/status", (_req: Request, res: Response) => {
  const poller = getPoller();
  const apiKeyConfigured = !!getApiKey();

  if (!poller) {
    res.json({
      connected: false,
      apiKeyConfigured,
      status: null,
    });
    return;
  }

  res.json({
    connected: true,
    apiKeyConfigured,
    status: poller.getStatus(),
  });
});

export default router;
