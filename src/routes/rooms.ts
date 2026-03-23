import { Router, Request, Response } from "express";
import { getRoom, isPlayerInRoom, joinRoom, leaveRoom, listRooms } from "../state/rooms";
import { getStateForRoom } from "../state/store";
import { getCurrentPhase, getQuestionIndex } from "../engine/roundController";
import { getLeaderboardForPeriod, initializePlayerRoom, registerPlayer, submitAnswer, submitAnswerForRegistered, isRegistered } from "../state/players";
import { addClient, removeClient } from "../sse/broker";
import { isGameplayRoomSupported } from "../state/rooms";
import type { LeaderboardPeriod } from "../types/quiz";

const router = Router();

function isRoomOpen(roomId: string, res: Response, ok = false): boolean {
  if (!isGameplayRoomSupported(roomId)) {
    res.status(409).json(
      ok
        ? { ok: false, error: "Room is closed", roomId }
        : { error: "Room is closed", roomId }
    );
    return false;
  }

  return true;
}

router.get("/", (req: Request, res: Response) => {
  const includeClosed = req.query.includeClosed === "true";
  return res.json({
    rooms: listRooms(includeClosed),
  });
});

router.get("/:roomId", (req: Request<{ roomId: string }>, res: Response) => {
  const room = getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  return res.json({ room });
});

router.get("/:roomId/leaderboard", (req: Request<{ roomId: string }>, res: Response) => {
  const room = getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  const periodRaw = req.query.period;
  const period: LeaderboardPeriod =
    periodRaw === "daily" || periodRaw === "weekly" || periodRaw === "all-time"
      ? periodRaw
      : "all-time";

  return res.json({
    leaderboard: getLeaderboardForPeriod(period, { roomId: room.roomId }),
  });
});

router.post("/:roomId/join", (req: Request<{ roomId: string }>, res: Response) => {
  const room = getRoom(req.params.roomId);
  const userId = req.body?.userId as string | undefined;

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  if (!userId || !isRegistered(userId)) {
    return res.status(401).json({ ok: false, error: "Register before joining a room", reason: "not_registered" });
  }

  if (!isRoomOpen(room.roomId, res, true)) {
    return;
  }

  initializePlayerRoom(userId, room.roomId);
  const membership = joinRoom(room.roomId, userId);
  return res.json({ ok: true, room, membership });
});

router.post("/:roomId/leave", (req: Request<{ roomId: string }>, res: Response) => {
  const room = getRoom(req.params.roomId);
  const userId = req.body?.userId as string | undefined;

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId is required" });
  }

  if (!isPlayerInRoom(room.roomId, userId)) {
    return res.status(409).json({ ok: false, error: "Player is not in this room", reason: "not_joined" });
  }

  leaveRoom(room.roomId, userId);
  return res.json({ ok: true });
});

router.get("/:roomId/state", (req: Request<{ roomId: string }>, res: Response) => {
  const room = getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (!isRoomOpen(room.roomId, res)) {
    return;
  }

  return res.json(getStateForRoom(room.roomId));
});

router.get("/:roomId/events", (req: Request<{ roomId: string }>, res: Response) => {
  const room = getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (!isRoomOpen(room.roomId, res)) {
    return;
  }

  const userId = req.query.userId as string | undefined;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setTimeout(0);
  res.flushHeaders();

  const clientId = addClient(res, userId, room.roomId);
  req.on("close", () => {
    removeClient(clientId);
  });
});

router.post("/:roomId/register", (req: Request<{ roomId: string }>, res: Response) => {
  const room = getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  if (!isRoomOpen(room.roomId, res, true)) {
    return;
  }

  const { username, userId } = req.body as { username?: string; userId?: string };
  if (!username || typeof username !== "string") {
    return res.status(400).json({
      ok: false,
      reason: "invalid_format",
      message: "Username is required",
    });
  }

  const result = registerPlayer(username, userId);
  if (!result.ok) {
    return res.status(result.reason === "username_taken" ? 409 : 400).json(result);
  }

  initializePlayerRoom(result.userId!, room.roomId);
  joinRoom(room.roomId, result.userId!);

  return res.json({
    ...result,
    roomId: room.roomId,
  });
});

router.post("/:roomId/answer", (req: Request<{ roomId: string }>, res: Response) => {
  const room = getRoom(req.params.roomId);
  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  if (!isRoomOpen(room.roomId, res, true)) {
    return;
  }

  const { userId, name, username, choiceId } = req.body as {
    userId?: string;
    name?: string;
    username?: string;
    choiceId?: string;
  };

  if (!userId || !choiceId) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields: userId, choiceId",
    });
  }

  const validChoices = ["a", "b", "c", "d"];
  const normalizedChoiceId = choiceId.toLowerCase();
  if (!validChoices.includes(normalizedChoiceId)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid choiceId. Must be a, b, c, or d",
    });
  }

  const phase = getCurrentPhase(room.roomId);
  if (phase !== "OPEN") {
    return res.status(409).json({
      ok: false,
      error: `Answers not accepted during ${phase} phase`,
      phase,
    });
  }

  const questionIndex = getQuestionIndex(room.roomId);
  if (userId.startsWith("yt:")) {
    const displayName = name || username || "YouTuber";
    initializePlayerRoom(userId, room.roomId);
    if (!isPlayerInRoom(room.roomId, userId)) {
      joinRoom(room.roomId, userId);
    }
    const accepted = submitAnswer(questionIndex, userId, displayName, normalizedChoiceId, room.roomId);
    return res.json({ ok: true, accepted, ...(accepted ? {} : { reason: "already_answered" }) });
  }

  if (!isRegistered(userId)) {
    return res.status(401).json({
      ok: false,
      error: "Not registered. Call POST /register first.",
      reason: "not_registered",
    });
  }

  initializePlayerRoom(userId, room.roomId);
  if (!isPlayerInRoom(room.roomId, userId)) {
    joinRoom(room.roomId, userId);
  }

  const result = submitAnswerForRegistered(questionIndex, userId, normalizedChoiceId, room.roomId);
  return res.json({
    ok: true,
    accepted: result.accepted,
    ...(result.accepted ? {} : { reason: result.reason }),
  });
});

export default router;
