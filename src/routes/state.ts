/**
 * GET /state - Returns current QuizState JSON
 */

import { Router, Request, Response } from "express";
import { getStateForRoom } from "../state/store";
import { DEFAULT_ROOM_ID, isGameplayRoomSupported, requireRoom } from "../state/rooms";
import { isQuestionContentAvailable } from "../engine/roundController";

const router = Router();

function isRoomOpen(roomId: string, res: Response): boolean {
  if (!isGameplayRoomSupported(roomId)) {
    res.status(409).json({
      error: "Room is closed",
      roomId,
    });
    return false;
  }

  return true;
}

function handleState(_req: Request, res: Response, roomId: string): void {
  try {
    requireRoom(roomId);
  } catch {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  if (!isRoomOpen(roomId, res)) {
    return;
  }
  if (!isQuestionContentAvailable(roomId)) {
    res.status(503).json({
      ok: false,
      reason: "canonical_content_unavailable",
      error: "Canonical quiz content is temporarily unavailable",
    });
    return;
  }

  const state = getStateForRoom(roomId);
  res.json(state);
}

router.get("/", (req: Request, res: Response) => {
  const roomId = (req.query.roomId as string | undefined) || DEFAULT_ROOM_ID;
  handleState(req, res, roomId);
});

router.get("/:roomId", (req: Request<{ roomId: string }>, res: Response) => {
  handleState(req, res, req.params.roomId);
});

export default router;
