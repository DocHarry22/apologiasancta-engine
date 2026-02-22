/**
 * GET /events - Server-Sent Events stream
 * Optional query param: ?userId=... for personalized streams with 'me' data
 */

import { Router, Request, Response } from "express";
import { addClient, removeClient } from "../sse/broker";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  // Get optional userId for personalized stream
  const userId = req.query.userId as string | undefined;

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
  const clientId = addClient(res, userId);

  // Handle client disconnect
  req.on("close", () => {
    removeClient(clientId);
  });

  // Keep connection open (don't call res.end())
});

export default router;
