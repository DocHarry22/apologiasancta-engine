import { Router, type Request, type Response } from "express";
import { createRateLimit, stopRateLimitCleanup } from "../middleware/rateLimit";
import { requirePlayerAuthorization } from "../security/playerAuthorization";
import { signJoinToken } from "../security/joinToken";
import {
  getPlayer,
  getPlayerInfo,
  getPlayerRank,
  initializePlayerRoom,
  isUsernameTaken,
  isValidUsername,
  registerPlayer,
} from "../state/players";
import { DEFAULT_ROOM_ID, getPlayerRooms, isGameplayRoomSupported, joinRoom, requireRoom } from "../state/rooms";

const router = Router();
export const DEFAULT_REGISTRATION_RATE_LIMIT_MAX = 120;
export const DEFAULT_REGISTRATION_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export const registrationRateLimit = createRateLimit({
  name: "REGISTER",
  max: DEFAULT_REGISTRATION_RATE_LIMIT_MAX,
  windowMs: DEFAULT_REGISTRATION_RATE_LIMIT_WINDOW_MS,
  message: "Too many registration attempts. Try again later.",
});

type RegisterBody = { username?: unknown; userId?: unknown; roomId?: unknown };
type RenameBody = { userId?: unknown; newUsername?: unknown; roomId?: unknown };

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function validateRoom(res: Response, roomId: string): boolean {
  try {
    requireRoom(roomId);
  } catch {
    res.status(404).json({ ok: false, reason: "room_not_found", error: "Room not found" });
    return false;
  }
  if (!isGameplayRoomSupported(roomId)) {
    res.status(409).json({ ok: false, reason: "room_closed", error: "Room is closed", roomId });
    return false;
  }
  return true;
}

export function handleRegister(req: Request, res: Response, roomId: string): void {
  if (!validateRoom(res, roomId)) return;
  const body = req.body as RegisterBody;
  if (typeof body?.username !== "string") {
    res.status(400).json({ ok: false, reason: "invalid_format", error: "A display name is required" });
    return;
  }

  let authorizedUserId: string | undefined;
  if (body.userId !== undefined) {
    if (typeof body.userId !== "string" || body.userId.length > 200) {
      res.status(400).json({ ok: false, reason: "invalid_user_id", error: "Invalid player ID" });
      return;
    }
    const authorization = requirePlayerAuthorization(req, res, {
      userId: body.userId,
      allowDifferentRoom: true,
      allowExpired: true,
    });
    if (!authorization) return;
    authorizedUserId = body.userId;
  }

  const result = registerPlayer(body.username, authorizedUserId);
  if (!result.ok || !result.userId || !result.username) {
    res.status(result.reason === "username_taken" ? 409 : 400).json(result);
    return;
  }
  initializePlayerRoom(result.userId, roomId);
  joinRoom(roomId, result.userId);
  res.json({
    ...result,
    roomId,
    joinToken: signJoinToken(roomId, result.userId, result.username),
  });
}

function handleMe(req: Request, res: Response, roomId: string): void {
  if (!validateRoom(res, roomId)) return;
  const userId = req.query.userId;
  if (typeof userId !== "string" || !userId) {
    res.status(400).json({ ok: false, reason: "missing_user_id", error: "userId is required" });
    return;
  }
  const authorization = requirePlayerAuthorization(req, res, { userId, allowDifferentRoom: true, allowExpired: true });
  if (!authorization) return;
  const player = getPlayer(userId);
  if (!player) {
    res.status(404).json({ ok: false, reason: "not_registered", error: "Player not found" });
    return;
  }
  initializePlayerRoom(userId, roomId);
  joinRoom(roomId, userId);
  res.json({
    ok: true,
    userId,
    username: player.username,
    totalPoints: getPlayerInfo(userId, roomId)?.totalPoints ?? 0,
    streak: getPlayerInfo(userId, roomId)?.streak ?? 0,
    rank: getPlayerRank(userId, roomId),
    roomId,
    rooms: getPlayerRooms(userId),
    joinToken: signJoinToken(roomId, userId, player.username),
  });
}

function handleRank(req: Request, res: Response, roomId: string): void {
  if (!validateRoom(res, roomId)) return;
  const userId = req.query.userId;
  if (typeof userId !== "string" || !userId) {
    res.status(400).json({ ok: false, reason: "missing_user_id", error: "userId is required" });
    return;
  }
  const info = getPlayerInfo(userId, roomId);
  if (!info) {
    res.status(404).json({ ok: false, reason: "not_registered", error: "Player not found" });
    return;
  }
  res.json({ ok: true, ...info, roomId });
}

function handleRename(req: Request, res: Response, roomId: string): void {
  if (!validateRoom(res, roomId)) return;
  const body = req.body as RenameBody;
  if (typeof body.userId !== "string" || typeof body.newUsername !== "string") {
    res.status(400).json({ ok: false, reason: "invalid_format", error: "userId and newUsername are required" });
    return;
  }
  const authorization = requirePlayerAuthorization(req, res, { userId: body.userId, allowDifferentRoom: true, allowExpired: true });
  if (!authorization) return;
  if (!getPlayer(body.userId)) {
    res.status(404).json({ ok: false, reason: "not_registered", error: "Player not found" });
    return;
  }
  const result = registerPlayer(body.newUsername, body.userId);
  if (!result.ok || !result.userId || !result.username) {
    res.status(result.reason === "username_taken" ? 409 : 400).json(result);
    return;
  }
  initializePlayerRoom(result.userId, roomId);
  joinRoom(roomId, result.userId);
  res.json({ ...result, roomId, joinToken: signJoinToken(roomId, result.userId, result.username) });
}

function handleCheck(req: Request, res: Response, roomId: string): void {
  if (!validateRoom(res, roomId)) return;
  const username = req.query.username;
  if (typeof username !== "string" || !username) {
    res.status(400).json({ ok: false, available: false, reason: "missing_username" });
    return;
  }
  const normalized = username.trim().replace(/\s+/g, "_").slice(0, 20);
  if (!isValidUsername(normalized)) {
    res.json({ ok: true, available: false, reason: "invalid_format", error: "Use 3-20 letters, numbers, or underscores" });
    return;
  }
  const taken = isUsernameTaken(normalized);
  res.json({ ok: true, available: !taken, username: normalized, ...(taken ? { reason: "username_taken" } : {}) });
}

router.post("/", registrationRateLimit, (req, res) => {
  const roomId = typeof (req.body as RegisterBody)?.roomId === "string" ? (req.body as { roomId: string }).roomId : DEFAULT_ROOM_ID;
  handleRegister(req, res, roomId);
});
router.get("/me", (req, res) => handleMe(req, res, typeof req.query.roomId === "string" ? req.query.roomId : DEFAULT_ROOM_ID));
router.get("/rank", (req, res) => handleRank(req, res, typeof req.query.roomId === "string" ? req.query.roomId : DEFAULT_ROOM_ID));
router.post("/rename", registrationRateLimit, (req, res) => {
  const roomId = typeof (req.body as RenameBody)?.roomId === "string" ? (req.body as { roomId: string }).roomId : DEFAULT_ROOM_ID;
  handleRename(req, res, roomId);
});
router.get("/check", (req, res) => handleCheck(req, res, typeof req.query.roomId === "string" ? req.query.roomId : DEFAULT_ROOM_ID));
router.post("/:roomId", registrationRateLimit, (req, res) => handleRegister(req, res, routeParam(req.params.roomId)));
router.get("/:roomId/me", (req, res) => handleMe(req, res, routeParam(req.params.roomId)));
router.get("/:roomId/rank", (req, res) => handleRank(req, res, routeParam(req.params.roomId)));
router.post("/:roomId/rename", registrationRateLimit, (req, res) => handleRename(req, res, routeParam(req.params.roomId)));
router.get("/:roomId/check", (req, res) => handleCheck(req, res, routeParam(req.params.roomId)));

export { stopRateLimitCleanup };
export default router;
