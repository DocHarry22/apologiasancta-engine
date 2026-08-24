import { Router, type NextFunction, type Request, type Response } from "express";
import {
  getArgument,
  getArgumentCoverage,
  getArgumentsForNode,
  getPath,
  getTopic,
  listTopics,
} from "../knowledge/journeys";

const router = Router();

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

router.get("/topics", asyncRoute(async (req, res) => {
  const topics = await listTopics(req.query.limit);
  res.json({ topics });
}));

router.get("/topics/:id", asyncRoute(async (req, res) => {
  const topic = await getTopic(req.params.id);
  if (!topic) {
    res.status(404).json({ error: "Knowledge topic not found" });
    return;
  }
  res.json(topic);
}));

router.get("/paths/:id", asyncRoute(async (req, res) => {
  const path = await getPath(req.params.id);
  if (!path) {
    res.status(404).json({ error: "Knowledge path not found" });
    return;
  }
  res.json(path);
}));

router.get("/arguments/:id/coverage", asyncRoute(async (req, res) => {
  const coverage = await getArgumentCoverage(req.params.id);
  if (!coverage) {
    res.status(404).json({ error: "Knowledge argument not found" });
    return;
  }
  res.json(coverage);
}));

router.get("/arguments/:id", asyncRoute(async (req, res) => {
  const argument = await getArgument(req.params.id);
  if (!argument) {
    res.status(404).json({ error: "Knowledge argument not found" });
    return;
  }
  res.json(argument);
}));

router.get("/nodes/:id/arguments", asyncRoute(async (req, res) => {
  const argumentsForNode = await getArgumentsForNode(req.params.id);
  res.json({ nodeId: req.params.id, arguments: argumentsForNode });
}));

export default router;
