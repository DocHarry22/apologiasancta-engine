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
  initializePlayerRoom,
} from "../state/players";
import { DEFAULT_ROOM_ID, getPlayerRooms, isGameplayRoomSupported, joinRoom, requireRoom } from "../state/rooms";

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
  roomId?: string;
}

interface RenameBody {
  userId: string;
  newUsername: string;
  roomId?: string;
}

function validateRoomForGameplay(res: Response, roomId: string): boolean {
  try {
    requireRoom(roomId);
  } catch {
    res.status(404).json({ ok: false, error: "Room not found" });
    return false;
  }

  if (!isGameplayRoomSupported(roomId)) {
    res.status(409).json({
      ok: false,
      error: "Room is closed",
      roomId,
    });
    return false;
  }

  return true;
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
function handleRegister(req: Request, res: Response, roomId: string): void {
  if (!validateRoomForGameplay(res, roomId)) {
    return;
  }

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

  initializePlayerRoom(result.userId!, roomId);
  joinRoom(roomId, result.userId!);

  res.json({
    ...result,
    roomId,
  });
}

router.post("/", (req: Request, res: Response) => {
  const roomId = (req.body as RegisterBody | undefined)?.roomId || DEFAULT_ROOM_ID;
  handleRegister(req, res, roomId);
});

/**
 * GET /me?userId=...
 * 
 * Returns current player state or 404 if not registered
 */
function handleMe(req: Request, res: Response, roomId: string): void {
  if (!validateRoomForGameplay(res, roomId)) {
    return;
  }

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

  initializePlayerRoom(userId, roomId);
  joinRoom(roomId, userId);

  res.json({
    ok: true,
    userId: player.userId,
    username: player.username,
    totalPoints: getPlayerInfo(userId, roomId)?.totalPoints ?? 0,
    streak: getPlayerInfo(userId, roomId)?.streak ?? 0,
    rank: getPlayerRank(userId, roomId),
    roomId,
    rooms: getPlayerRooms(userId),
  });
}

router.get("/me", (req: Request, res: Response) => {
  const roomId = (req.query.roomId as string | undefined) || DEFAULT_ROOM_ID;
  handleMe(req, res, roomId);
});

/**
 * GET /rank?userId=...
 * 
 * Returns player's rank and distance to top 10
 */
function handleRank(req: Request, res: Response, roomId: string): void {
  if (!validateRoomForGameplay(res, roomId)) {
    return;
  }

  const userId = req.query.userId as string;

  if (!userId) {
    res.status(400).json({
      ok: false,
      reason: "missing_userId",
      message: "userId query parameter required",
    });
    return;
  }

  const info = getPlayerInfo(userId, roomId);
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
    roomId,
  });
}

router.get("/rank", (req: Request, res: Response) => {
  const roomId = (req.query.roomId as string | undefined) || DEFAULT_ROOM_ID;
  handleRank(req, res, roomId);
});

/**
 * POST /rename
 * Body: { userId: string, newUsername: string }
 * 
 * Allows changing username (same uniqueness rules)
 */
function handleRename(req: Request, res: Response, roomId: string): void {
  if (!validateRoomForGameplay(res, roomId)) {
    return;
  }

  const { userId, newUsername } = req.body as RenameBody;

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

  initializePlayerRoom(userId, roomId);
  joinRoom(roomId, userId);

  res.json({
    ...result,
    roomId,
  });
}

router.post("/rename", (req: Request, res: Response) => {
  const roomId = (req.body as RenameBody | undefined)?.roomId || DEFAULT_ROOM_ID;
  handleRename(req, res, roomId);
});

/**
 * GET /check?username=...
 * 
 * Check if a username is available (without actually registering)
 */
function handleCheck(req: Request, res: Response, roomId: string): void {
  if (!validateRoomForGameplay(res, roomId)) {
    return;
  }

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
}

router.get("/check", (req: Request, res: Response) => {
  const roomId = (req.query.roomId as string | undefined) || DEFAULT_ROOM_ID;
  handleCheck(req, res, roomId);
});

router.post("/:roomId", (req: Request<{ roomId: string }>, res: Response) => {
  handleRegister(req, res, req.params.roomId);
});

router.get("/:roomId/me", (req: Request<{ roomId: string }>, res: Response) => {
  handleMe(req, res, req.params.roomId);
});

router.get("/:roomId/rank", (req: Request<{ roomId: string }>, res: Response) => {
  handleRank(req, res, req.params.roomId);
});

router.post("/:roomId/rename", (req: Request<{ roomId: string }>, res: Response) => {
  handleRename(req, res, req.params.roomId);
});

router.get("/:roomId/check", (req: Request<{ roomId: string }>, res: Response) => {
  handleCheck(req, res, req.params.roomId);
});

export default router;
