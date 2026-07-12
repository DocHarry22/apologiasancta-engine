/**
 * POST /answer - Submit an answer
 */

import { Router, Request, Response } from "express";
import { getAnswerWindowStatus } from "../engine/roundController";
import { submitAnswer, submitAnswerForRegistered, isRegistered, initializePlayerRoom } from "../state/players";
import { DEFAULT_ROOM_ID, isGameplayRoomSupported, isPlayerInRoom, joinRoom, requireRoom } from "../state/rooms";

const router = Router();

interface AnswerBody {
  userId: string;
  name?: string;     // Optional: only needed for YouTube auto-registration
  username?: string; // Preferred: for registered mobile users
  choiceId: string;
  roomId?: string;
}

function handleAnswer(req: Request, res: Response, roomId: string): void {
  try {
    requireRoom(roomId);
  } catch {
    res.status(404).json({ ok: false, error: "Room not found" });
    return;
  }

  if (!isGameplayRoomSupported(roomId)) {
    res.status(409).json({
      ok: false,
      error: "Room is closed",
      roomId,
    });
    return;
  }

  const { userId, name, username, choiceId } = req.body as AnswerBody;

  // Validate required fields
  if (!userId || !choiceId) {
    res.status(400).json({
      ok: false,
      error: "Missing required fields: userId, choiceId",
    });
    return;
  }

  // Validate field types and lengths to prevent oversized inputs
  if (typeof userId !== "string" || userId.length > 200) {
    res.status(400).json({
      ok: false,
      error: "Invalid userId: must be a string of at most 200 characters",
    });
    return;
  }

  if (typeof choiceId !== "string") {
    res.status(400).json({
      ok: false,
      error: "Invalid choiceId: must be a string",
    });
    return;
  }

  // Validate choiceId format
  const validChoices = ["a", "b", "c", "d"];
  if (!validChoices.includes(choiceId.toLowerCase())) {
    res.status(400).json({
      ok: false,
      error: "Invalid choiceId. Must be a, b, c, or d",
    });
    return;
  }

  const answerWindow = getAnswerWindowStatus(roomId);
  if (!answerWindow.accepting) {
    res.status(409).json({
      ok: false,
      accepted: false,
      error: answerWindow.reason === "too_late"
        ? "Answer deadline has passed"
        : answerWindow.reason === "game_paused"
          ? "Quiz is paused"
          : "Answers are locked",
      reason: answerWindow.reason,
      phase: answerWindow.phase,
      endsAtMs: answerWindow.endsAtMs,
    });
    return;
  }

  const questionIndex = answerWindow.questionIndex;
  const normalizedChoiceId = choiceId.toLowerCase();

  // Handle YouTube vs Mobile answers differently
  const isYouTubeUser = userId.startsWith("yt:");
  
  if (isYouTubeUser) {
    // YouTube users: auto-register with collision handling
    const displayName = name || username || "YouTuber";
    initializePlayerRoom(userId, roomId);
    joinRoom(roomId, userId);
    const accepted = submitAnswer(questionIndex, userId, displayName, normalizedChoiceId, roomId);
    
    if (!accepted) {
      res.json({
        ok: true,
        accepted: false,
        reason: "already_answered",
      });
      return;
    }
    
    res.json({
      ok: true,
      accepted: true,
    });
    return;
  }

  // Mobile users: require registration
  if (!isRegistered(userId)) {
    res.status(401).json({
      ok: false,
      error: "Not registered. Call POST /register first.",
      reason: "not_registered",
    });
    return;
  }

  initializePlayerRoom(userId, roomId);
  if (!isPlayerInRoom(roomId, userId)) {
    joinRoom(roomId, userId);
  }

  const result = submitAnswerForRegistered(questionIndex, userId, normalizedChoiceId, roomId);

  if (!result.accepted) {
    res.json({
      ok: true,
      accepted: false,
      reason: result.reason,
    });
    return;
  }

  res.json({
    ok: true,
    accepted: true,
  });
}

router.post("/", (req: Request, res: Response) => {
  const roomId = (req.body as AnswerBody | undefined)?.roomId || DEFAULT_ROOM_ID;
  handleAnswer(req, res, roomId);
});

router.post("/:roomId", (req: Request<{ roomId: string }>, res: Response) => {
  handleAnswer(req, res, req.params.roomId);
});

export default router;
