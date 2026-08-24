import { Router, type NextFunction, type Request, type Response } from "express";
import {
  comparePublishedNodes,
  getPublishedDebate,
  getPublishedTimeline,
} from "../knowledge/advanced";

const router = Router();

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function immutablePublic(res: Response): void {
  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
}

router.get("/timeline", asyncRoute(async (req, res) => {
  const payload = await getPublishedTimeline({
    nodeId: req.query.nodeId,
    topicId: req.query.topicId,
    domain: req.query.domain,
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit,
  });
  immutablePublic(res);
  res.json(payload);
}));

router.get("/compare/advanced", asyncRoute(async (req, res) => {
  const left = typeof req.query.left === "string" ? req.query.left : "";
  const right = typeof req.query.right === "string" ? req.query.right : "";
  if (!left || !right) {
    res.status(400).json({ error: "left and right canonical node ids are required" });
    return;
  }
  const payload = await comparePublishedNodes(left, right, req.query.lens);
  if (!payload) {
    res.status(404).json({ error: "Both published nodes are required for comparison" });
    return;
  }
  immutablePublic(res);
  res.json(payload);
}));

router.get("/debate/:argumentId", asyncRoute(async (req, res) => {
  const payload = await getPublishedDebate(req.params.argumentId);
  if (!payload) {
    res.status(404).json({ error: "Published knowledge argument not found" });
    return;
  }
  immutablePublic(res);
  res.json(payload);
}));

export default router;
