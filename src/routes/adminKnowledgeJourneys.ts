import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAdmin } from "./admin";
import {
  createArgument,
  createPath,
  createTopic,
  getArgument,
  getArgumentCoverage,
  getPath,
  getTopic,
  publishJourneyRevision,
  recordJourneyReview,
  reviseArgument,
  revisePath,
  reviseTopic,
} from "../knowledge/journeys";

const router = Router();
router.use(requireAdmin);

function actor(req: Request): string {
  const supplied = req.get("x-editor-id")?.trim();
  return supplied ? supplied.slice(0, 200) : "admin-token";
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

router.post("/topics", asyncRoute(async (req, res) => {
  res.status(201).json(await createTopic(req.body, actor(req)));
}));

router.put("/topics/:id", asyncRoute(async (req, res) => {
  res.json(await reviseTopic(req.params.id, req.body, actor(req)));
}));

router.get("/topics/:id", asyncRoute(async (req, res) => {
  const value = await getTopic(req.params.id, true);
  if (!value) {
    res.status(404).json({ error: "Knowledge topic not found" });
    return;
  }
  res.json(value);
}));

router.post("/paths", asyncRoute(async (req, res) => {
  res.status(201).json(await createPath(req.body, actor(req)));
}));

router.put("/paths/:id", asyncRoute(async (req, res) => {
  res.json(await revisePath(req.params.id, req.body, actor(req)));
}));

router.get("/paths/:id", asyncRoute(async (req, res) => {
  const value = await getPath(req.params.id, true);
  if (!value) {
    res.status(404).json({ error: "Knowledge path not found" });
    return;
  }
  res.json(value);
}));

router.post("/arguments", asyncRoute(async (req, res) => {
  res.status(201).json(await createArgument(req.body, actor(req)));
}));

router.put("/arguments/:id", asyncRoute(async (req, res) => {
  res.json(await reviseArgument(req.params.id, req.body, actor(req)));
}));

router.get("/arguments/:id/coverage", asyncRoute(async (req, res) => {
  const value = await getArgumentCoverage(req.params.id, true);
  if (!value) {
    res.status(404).json({ error: "Knowledge argument not found" });
    return;
  }
  res.json(value);
}));

router.get("/arguments/:id", asyncRoute(async (req, res) => {
  const value = await getArgument(req.params.id, true);
  if (!value) {
    res.status(404).json({ error: "Knowledge argument not found" });
    return;
  }
  res.json(value);
}));

router.post("/reviews", asyncRoute(async (req, res) => {
  res.status(201).json(await recordJourneyReview(req.body, actor(req)));
}));

router.post("/publish", asyncRoute(async (req, res) => {
  res.json(await publishJourneyRevision(req.body, actor(req)));
}));

export default router;
