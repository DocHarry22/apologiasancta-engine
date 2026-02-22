/**
 * GET /health - Health check endpoint
 */

import { Router, Request, Response } from "express";
import { getClientCount } from "../sse/broker";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    uptime: process.uptime(),
    clients: getClientCount(),
  });
});

export default router;
