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
} from "../engine/roundController";
import { getPlayerCount } from "../state/players";

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

export default router;
