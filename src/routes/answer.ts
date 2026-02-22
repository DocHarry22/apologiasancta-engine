/**
 * POST /answer - Submit an answer
 */

import { Router, Request, Response } from "express";
import { getCurrentPhase, getQuestionIndex } from "../engine/roundController";
import { submitAnswer, submitAnswerForRegistered, isRegistered, getOrCreatePlayer } from "../state/players";

const router = Router();

interface AnswerBody {
  userId: string;
  name?: string;     // Optional: only needed for YouTube auto-registration
  username?: string; // Preferred: for registered mobile users
  choiceId: string;
}

router.post("/", (req: Request, res: Response) => {
  const { userId, name, username, choiceId } = req.body as AnswerBody;

  // Validate required fields
  if (!userId || !choiceId) {
    res.status(400).json({
      ok: false,
      error: "Missing required fields: userId, choiceId",
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

  const questionIndex = getQuestionIndex();
  const normalizedChoiceId = choiceId.toLowerCase();

  // Handle YouTube vs Mobile answers differently
  const isYouTubeUser = userId.startsWith("yt:");
  
  if (isYouTubeUser) {
    // YouTube users: auto-register with collision handling
    const displayName = name || username || "YouTuber";
    const accepted = submitAnswer(questionIndex, userId, displayName, normalizedChoiceId);
    
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

  const result = submitAnswerForRegistered(questionIndex, userId, normalizedChoiceId);

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
});

export default router;
