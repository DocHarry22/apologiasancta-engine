import { Router, type Request, type Response } from "express";
import { getAnswerWindowStatus } from "../engine/roundController";
import { createRateLimit } from "../middleware/rateLimit";
import { requirePlayerAuthorization } from "../security/playerAuthorization";
import { initializePlayerRoom, isRegistered, submitAnswerForRegistered } from "../state/players";
import { DEFAULT_ROOM_ID, isGameplayRoomSupported, isPlayerInRoom, requireRoom } from "../state/rooms";

const router = Router();
export const answerRateLimit = createRateLimit({
  name: "ANSWER",
  max: 90,
  windowMs: 60_000,
  message: "Too many answer requests. Wait for the next question.",
  key: (req) => `${req.ip}:${typeof req.body?.userId === "string" ? req.body.userId : "unknown"}`,
});

type AnswerBody = { userId?: unknown; choiceId?: unknown; roomId?: unknown };

export function processAnswer(req: Request, res: Response, roomId: string): void {
  try {
    requireRoom(roomId);
  } catch {
    res.status(404).json({ ok: false, reason: "room_not_found", error: "Room not found" });
    return;
  }
  if (!isGameplayRoomSupported(roomId)) {
    res.status(409).json({ ok: false, reason: "room_closed", error: "Room is closed", roomId });
    return;
  }

  const { userId, choiceId } = req.body as AnswerBody;
  if (typeof userId !== "string" || !userId || userId.length > 200) {
    res.status(400).json({ ok: false, reason: "invalid_user_id", error: "A valid userId is required" });
    return;
  }
  if (typeof choiceId !== "string" || !["a", "b", "c", "d"].includes(choiceId.toLowerCase())) {
    res.status(400).json({ ok: false, reason: "invalid_choice", error: "choiceId must be a, b, c, or d" });
    return;
  }
  if (!isRegistered(userId)) {
    res.status(401).json({ ok: false, reason: "not_registered", error: "Join the room before answering" });
    return;
  }
  const authorization = requirePlayerAuthorization(req, res, { userId, roomId });
  if (!authorization) return;
  if (!isPlayerInRoom(roomId, userId)) {
    res.status(401).json({ ok: false, reason: "not_joined", error: "Rejoin this room before answering" });
    return;
  }

  const answerWindow = getAnswerWindowStatus(roomId);
  if (!answerWindow.accepting) {
    res.status(answerWindow.reason === "content_unavailable" ? 503 : 409).json({
      ok: false,
      accepted: false,
      reason: answerWindow.reason,
      error: answerWindow.reason === "too_late"
        ? "Answer deadline has passed"
        : answerWindow.reason === "content_unavailable"
          ? "Canonical quiz content is temporarily unavailable"
        : answerWindow.reason === "game_paused"
          ? "Quiz is paused"
          : "Answers are locked",
      phase: answerWindow.phase,
      endsAtMs: answerWindow.endsAtMs,
    });
    return;
  }

  initializePlayerRoom(userId, roomId);
  const result = submitAnswerForRegistered(answerWindow.questionIndex, userId, choiceId.toLowerCase(), roomId);
  if (!result.accepted) {
    res.status(result.reason === "already_answered" ? 409 : 400).json({ ok: false, accepted: false, reason: result.reason });
    return;
  }
  res.json({ ok: true, accepted: true, questionIndex: answerWindow.questionIndex, receivedAtMs: Date.now() });
}

router.use(answerRateLimit);
router.post("/", (req, res) => {
  const roomId = typeof (req.body as AnswerBody)?.roomId === "string" ? (req.body as { roomId: string }).roomId : DEFAULT_ROOM_ID;
  processAnswer(req, res, roomId);
});
router.post("/:roomId", (req, res) => processAnswer(req, res, req.params.roomId));

export default router;
