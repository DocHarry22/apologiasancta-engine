/**
 * GET /events - Server-Sent Events stream
 * Optional query param: ?userId=... for personalized streams with 'me' data
 */

import { Router, Request, Response } from "express";
import { addClient, removeClient } from "../sse/broker";
import { DEFAULT_ROOM_ID, isGameplayRoomSupported, requireRoom } from "../state/rooms";

const router = Router();

function handleEvents(req: Request, res: Response, roomId: string): void {
  // Get optional userId for personalized stream
  const userId = req.query.userId as string | undefined;

  try {
    requireRoom(roomId);
  } catch {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  if (!isGameplayRoomSupported(roomId)) {
    res.status(409).json({
      error: "Room is closed",
      roomId,
    });
    return;
  }

  // Set SSE headers for production compatibility
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx/Render buffering
  
  // Disable response timeout for long-lived connection
  res.setTimeout(0);

  // Flush headers immediately
  res.flushHeaders();

  // Register client (sends initial state, personalized if userId provided)
  const clientId = addClient(res, userId, roomId);

  // Handle client disconnect
  req.on("close", () => {
    removeClient(clientId);
  });

  // Keep connection open (don't call res.end())
}

router.get("/", (req: Request, res: Response) => {
  const roomId = (req.query.roomId as string | undefined) || DEFAULT_ROOM_ID;
  handleEvents(req, res, roomId);
});

router.get("/:roomId", (req: Request<{ roomId: string }>, res: Response) => {
  handleEvents(req, res, req.params.roomId);
});

export default router;
