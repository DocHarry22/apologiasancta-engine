/**
 * POST /register - Register a unique username
 * GET /me - Get current player state
 * GET /rank - Get player's rank info
 */

import { Router, Request, Response } from "express";
import {
  registerPlayer,
  getPlayer,
  getPlayerInfo,
  getPlayerRank,
  getDistanceToTop10,
  isValidUsername,
  isUsernameTaken,
} from "../state/players";

const router = Router();

/**
 * Simple rate limiting for registration
 * Map<IP, { count: number, resetAt: number }>
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }
  
  entry.count++;
  rateLimitMap.set(ip, entry);
  
  return entry.count <= RATE_LIMIT_MAX;
}

interface RegisterBody {
  username: string;
  userId?: string;
}

/**
 * POST /register
 * Body: { username: string, userId?: string }
 * 
 * Returns:
 * - 200 { ok: true, userId, username } on success
 * - 400 { ok: false, reason: "invalid_format", message } if invalid
 * - 409 { ok: false, reason: "username_taken", message } if taken
 * - 429 if rate limited
 */
router.post("/", (req: Request, res: Response) => {
  // Rate limiting
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(ip)) {
    res.status(429).json({
      ok: false,
      reason: "rate_limited",
      message: "Too many registration attempts. Try again in 10 minutes.",
    });
    return;
  }

  const { username, userId } = req.body as RegisterBody;

  // Validate input
  if (!username || typeof username !== "string") {
    res.status(400).json({
      ok: false,
      reason: "invalid_format",
      message: "Username is required",
    });
    return;
  }

  // Attempt registration
  const result = registerPlayer(username, userId);

  if (!result.ok) {
    const status = result.reason === "username_taken" ? 409 : 400;
    res.status(status).json(result);
    return;
  }

  res.json(result);
});

/**
 * GET /me?userId=...
 * 
 * Returns current player state or 404 if not registered
 */
router.get("/me", (req: Request, res: Response) => {
  const userId = req.query.userId as string;

  if (!userId) {
    res.status(400).json({
      ok: false,
      reason: "missing_userId",
      message: "userId query parameter required",
    });
    return;
  }

  const player = getPlayer(userId);
  if (!player) {
    res.status(404).json({
      ok: false,
      reason: "not_registered",
      message: "User not registered",
    });
    return;
  }

  res.json({
    ok: true,
    userId: player.userId,
    username: player.username,
    totalPoints: player.score,
    streak: player.streak,
    rank: getPlayerRank(userId),
  });
});

/**
 * GET /rank?userId=...
 * 
 * Returns player's rank and distance to top 10
 */
router.get("/rank", (req: Request, res: Response) => {
  const userId = req.query.userId as string;

  if (!userId) {
    res.status(400).json({
      ok: false,
      reason: "missing_userId",
      message: "userId query parameter required",
    });
    return;
  }

  const info = getPlayerInfo(userId);
  if (!info) {
    res.status(404).json({
      ok: false,
      reason: "not_registered",
      message: "User not registered",
    });
    return;
  }

  res.json({
    ok: true,
    rank: info.rank,
    totalPoints: info.totalPoints,
    streak: info.streak,
    distanceToTop10: info.distanceToTop10,
  });
});

/**
 * POST /rename
 * Body: { userId: string, newUsername: string }
 * 
 * Allows changing username (same uniqueness rules)
 */
router.post("/rename", (req: Request, res: Response) => {
  const { userId, newUsername } = req.body as { userId: string; newUsername: string };

  if (!userId || !newUsername) {
    res.status(400).json({
      ok: false,
      reason: "invalid_format",
      message: "userId and newUsername required",
    });
    return;
  }

  const current = getPlayer(userId);
  if (!current) {
    res.status(404).json({
      ok: false,
      reason: "not_registered",
      message: "User not registered",
    });
    return;
  }

  // Re-register with new username (this handles uniqueness)
  const result = registerPlayer(newUsername, userId);
  if (!result.ok) {
    const status = result.reason === "username_taken" ? 409 : 400;
    res.status(status).json(result);
    return;
  }

  res.json(result);
});

/**
 * GET /check?username=...
 * 
 * Check if a username is available (without actually registering)
 */
router.get("/check", (req: Request, res: Response) => {
  const username = req.query.username as string;

  if (!username) {
    res.status(400).json({
      ok: false,
      available: false,
      reason: "missing_username",
    });
    return;
  }

  // Validate format first
  const normalized = username.trim().replace(/\s+/g, "_").slice(0, 20);
  if (!isValidUsername(normalized)) {
    res.json({
      ok: true,
      available: false,
      reason: "invalid_format",
      message: "Username must be 3-20 characters, alphanumeric or underscore only",
    });
    return;
  }

  // Check availability via lookup (no registration)
  const isTaken = isUsernameTaken(normalized);

  res.json({
    ok: true,
    available: !isTaken,
    username: normalized,
    ...(isTaken ? { reason: "username_taken" } : {}),
  });
});

export default router;
