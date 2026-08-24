import { Router, type NextFunction, type Request, type Response } from "express";
import { getKnowledgeEngineStatus } from "../knowledge/db";
import {
  compareNodes,
  getNeighborhood,
  getNode,
  getNodeAssessments,
  getNodeEvidence,
  searchKnowledge,
} from "../knowledge/repository";

const router = Router();

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

router.get("/status", (_req, res) => {
  const status = getKnowledgeEngineStatus();
  res.status(status.ready || !status.required ? 200 : 503).json(status);
});

router.get("/search", asyncRoute(async (req, res) => {
  if (typeof req.query.q !== "string" || !req.query.q.trim()) {
    badRequest(res, "q is required");
    return;
  }
  const results = await searchKnowledge(req.query.q, {
    kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
    limit: Number.parseInt(String(req.query.limit ?? "25"), 10) || 25,
  });
  res.json({ results });
}));

router.get("/neighborhood", asyncRoute(async (req, res) => {
  if (typeof req.query.nodeId !== "string" || !req.query.nodeId.trim()) {
    badRequest(res, "nodeId is required");
    return;
  }
  const payload = await getNeighborhood(req.query.nodeId, req.query.depth, {
    lens: typeof req.query.lens === "string" ? req.query.lens : undefined,
    limit: Number.parseInt(String(req.query.limit ?? "120"), 10) || 120,
  });
  if (!payload) {
    res.status(404).json({ error: "Knowledge node not found" });
    return;
  }
  res.json(payload);
}));

router.get("/nodes/:id/evidence", asyncRoute(async (req, res) => {
  const payload = await getNodeEvidence(req.params.id);
  if (!payload) {
    res.status(404).json({ error: "Knowledge node not found" });
    return;
  }
  res.json(payload);
}));

router.get("/nodes/:id/assessments", asyncRoute(async (req, res) => {
  const assessments = await getNodeAssessments(req.params.id, req.query.lens);
  res.json({ nodeId: req.params.id, assessments });
}));

router.get("/nodes/:id", asyncRoute(async (req, res) => {
  const node = await getNode(req.params.id);
  if (!node) {
    res.status(404).json({ error: "Knowledge node not found" });
    return;
  }
  res.json(node);
}));

router.get("/compare", asyncRoute(async (req, res) => {
  if (typeof req.query.left !== "string" || typeof req.query.right !== "string") {
    badRequest(res, "left and right canonical node ids are required");
    return;
  }
  const comparison = await compareNodes(req.query.left, req.query.right);
  if (!comparison) {
    res.status(404).json({ error: "Both published nodes are required for comparison" });
    return;
  }
  res.json(comparison);
}));

export default router;
