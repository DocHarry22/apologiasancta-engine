/**
 * POST /answer - Submit an answer
 */

import { Router, Request, Response } from "express";
import { getCurrentPhase, getQuestionIndex } from "../engine/roundController";
import { submitAnswer } from "../state/players";

const router = Router();

interface AnswerBody {
  userId: string;
  name: string;
  choiceId: string;
}

router.post("/", (req: Request, res: Response) => {
  const { userId, name, choiceId } = req.body as AnswerBody;

  // Validate required fields
  if (!userId || !name || !choiceId) {
    res.status(400).json({
      ok: false,
      error: "Missing required fields: userId, name, choiceId",
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

  // Check if we're in OPEN phase
  const phase = getCurrentPhase();
  if (phase !== "OPEN") {
    res.status(409).json({
      ok: false,
      error: `Answers not accepted during ${phase} phase`,
      phase,
    });
    return;
  }

  // Submit answer
  const questionIndex = getQuestionIndex();
  const normalizedChoiceId = choiceId.toLowerCase();
  const accepted = submitAnswer(questionIndex, userId, name, normalizedChoiceId);

  if (!accepted) {
    // Already answered - return 200 with accepted: false per spec
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
});

export default router;
