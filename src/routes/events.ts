/**
 * GET /events - Server-Sent Events stream
 */

import { Router, Request, Response } from "express";
import { addClient, removeClient } from "../sse/broker";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  // Set SSE headers for production compatibility
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx/Render buffering
  
  // Disable response timeout for long-lived connection
  res.setTimeout(0);

  // Flush headers immediately
  res.flushHeaders();

  // Register client (sends initial state)
  const clientId = addClient(res);

  // Handle client disconnect
  req.on("close", () => {
    removeClient(clientId);
  });

  // Keep connection open (don't call res.end())
});

export default router;
