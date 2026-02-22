/**
 * GET /state - Returns current QuizState JSON
 */

import { Router, Request, Response } from "express";
import { getState } from "../state/store";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const state = getState();
  res.json(state);
});

export default router;
