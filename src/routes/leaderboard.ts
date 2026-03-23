import { Router, Request, Response } from "express";
import { getLeaderboardForPeriod } from "../state/players";
import type { LeaderboardPeriod } from "../types/quiz";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  const periodRaw = req.query.period;
  const period: LeaderboardPeriod =
    periodRaw === "daily" || periodRaw === "weekly" || periodRaw === "all-time"
      ? periodRaw
      : "all-time";

  return res.json({
    leaderboard: getLeaderboardForPeriod(period),
  });
});

export default router;