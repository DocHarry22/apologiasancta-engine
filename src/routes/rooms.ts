import { Router, type Request, type Response } from "express";
import { answerRateLimit, processAnswer } from "./answer";
import { handleRegister, registrationRateLimit } from "./register";
import { getAnswerWindowStatus } from "../engine/roundController";
import { isExpiredJoinTokenPayload, requirePlayerAuthorization } from "../security/playerAuthorization";
import { signJoinToken } from "../security/joinToken";
import { addClient, removeClient } from "../sse/broker";
import { getPlayer, getLeaderboardForPeriod, initializePlayerRoom, isRegistered } from "../state/players";
import { getStateForRoom } from "../state/store";
import { getRoom, isGameplayRoomSupported, isPlayerInRoom, joinRoom, leaveRoom, listRooms } from "../state/rooms";
import type { LeaderboardPeriod } from "../types/quiz";

const router = Router();

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function requireOpenRoom(roomId: string, res: Response): ReturnType<typeof getRoom> {
  const room = getRoom(roomId);
  if (!room) {
    res.status(404).json({ ok: false, reason: "room_not_found", error: "Room not found" });
    return null;
  }
  if (!isGameplayRoomSupported(roomId)) {
    res.status(409).json({ ok: false, reason: "room_closed", error: "Room is closed", roomId });
    return null;
  }
  return room;
}

router.get("/", (req, res) => res.json({ rooms: listRooms(req.query.includeClosed === "true") }));

router.get("/:roomId", (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "Room not found" });
  return res.json({ room });
});

router.get("/:roomId/leaderboard", (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "Room not found" });
  const raw = req.query.period;
  const period: LeaderboardPeriod = raw === "daily" || raw === "weekly" || raw === "all-time" ? raw : "all-time";
  return res.json({ leaderboard: getLeaderboardForPeriod(period, { roomId: room.roomId }) });
});

router.post("/:roomId/join", (req: Request<{ roomId: string }>, res) => {
  const room = requireOpenRoom(req.params.roomId, res);
  if (!room) return;
  const userId = req.body?.userId;
  if (typeof userId !== "string" || !isRegistered(userId)) {
    return res.status(401).json({ ok: false, reason: "not_registered", error: "Register before joining a room" });
  }
  const authorization = requirePlayerAuthorization(req, res, { userId, allowDifferentRoom: true, allowExpired: true });
  if (!authorization) return;
  const player = getPlayer(userId);
  if (!player) return res.status(404).json({ ok: false, reason: "not_registered", error: "Player not found" });
  if (isExpiredJoinTokenPayload(authorization) && authorization.displayName !== player.username) {
    return res.status(401).json({
      ok: false,
      reason: "join_token_expired",
      error: "Your room session expired. Rejoin with the same display name or sign in again.",
    });
  }
  initializePlayerRoom(userId, room.roomId);
  const membership = joinRoom(room.roomId, userId);
  return res.json({
    ok: true,
    room,
    membership,
    userId,
    username: player.username,
    joinToken: signJoinToken(room.roomId, userId, player.username),
  });
});

router.post("/:roomId/leave", (req: Request<{ roomId: string }>, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "Room not found" });
  const userId = req.body?.userId;
  if (typeof userId !== "string") return res.status(400).json({ ok: false, error: "userId is required" });
  const authorization = requirePlayerAuthorization(req, res, { userId, roomId: room.roomId });
  if (!authorization) return;
  if (!isPlayerInRoom(room.roomId, userId)) return res.status(409).json({ ok: false, reason: "not_joined", error: "Player is not in this room" });
  leaveRoom(room.roomId, userId);
  return res.json({ ok: true });
});

router.get("/:roomId/state", (req, res) => {
  const room = requireOpenRoom(req.params.roomId, res);
  return room ? res.json(getStateForRoom(room.roomId)) : undefined;
});

router.get("/:roomId/events", (req, res) => {
  const room = requireOpenRoom(req.params.roomId, res);
  if (!room) return;
  const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setTimeout(0);
  res.flushHeaders();
  const clientId = addClient(res, userId, room.roomId);
  req.on("close", () => removeClient(clientId));
});

router.post("/:roomId/register", registrationRateLimit, (req, res) => handleRegister(req, res, routeParam(req.params.roomId)));
router.post("/:roomId/answer", answerRateLimit, (req, res) => processAnswer(req, res, routeParam(req.params.roomId)));

router.get("/:roomId/answer-window", (req, res) => {
  const room = requireOpenRoom(req.params.roomId, res);
  return room ? res.json(getAnswerWindowStatus(room.roomId)) : undefined;
});

export default router;
