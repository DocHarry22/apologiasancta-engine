import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAdmin } from "./admin";
import {
  addClaimFamilyMember,
  createCitation,
  createEdge,
  createEdgeAssertion,
  createNode,
  createSource,
  getNeighborhood,
  getNode,
  getNodeAssessments,
  getNodeEvidence,
  getSource,
  publishRevision,
  reconciliationSuggestions,
  recordReview,
  reviseEdge,
  reviseNode,
  reviseSource,
  searchKnowledge,
  upsertAssessment,
} from "../knowledge/repository";
import { getEdgeForAuthoring, getExistingCanonicalIds } from "../knowledge/importSupport";

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

router.post("/nodes", asyncRoute(async (req, res) => {
  const node = await createNode(req.body, actor(req));
  res.status(201).json(node);
}));

router.patch("/nodes/:id", asyncRoute(async (req, res) => {
  const node = await reviseNode(req.params.id, req.body, actor(req));
  res.json(node);
}));

router.post("/edges", asyncRoute(async (req, res) => {
  const edge = await createEdge(req.body, actor(req));
  res.status(201).json(edge);
}));

router.patch("/edges/:id", asyncRoute(async (req, res) => {
  const edge = await reviseEdge(req.params.id, req.body, actor(req));
  res.json(edge);
}));

router.get("/edges/:id", asyncRoute(async (req, res) => {
  const edge = await getEdgeForAuthoring(req.params.id);
  if (!edge) {
    res.status(404).json({ error: "Knowledge edge not found" });
    return;
  }
  res.json(edge);
}));

router.post("/edge-assertions", asyncRoute(async (req, res) => {
  const assertion = await createEdgeAssertion(req.body);
  res.status(201).json(assertion);
}));

router.post("/sources", asyncRoute(async (req, res) => {
  const source = await createSource(req.body, actor(req));
  res.status(201).json(source);
}));

router.patch("/sources/:id", asyncRoute(async (req, res) => {
  const source = await reviseSource(req.params.id, req.body, actor(req));
  res.json(source);
}));

router.post("/citations", asyncRoute(async (req, res) => {
  const citation = await createCitation(req.body);
  res.status(201).json(citation);
}));

router.put("/assessments", asyncRoute(async (req, res) => {
  const assessment = await upsertAssessment(req.body);
  res.json(assessment);
}));

router.put("/claim-families/member", asyncRoute(async (req, res) => {
  await addClaimFamilyMember(req.body, actor(req));
  res.status(204).end();
}));

router.get("/search", asyncRoute(async (req, res) => {
  if (typeof req.query.q !== "string" || !req.query.q.trim()) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  const results = await searchKnowledge(req.query.q, {
    kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
    includeUnpublished: true,
    limit: Number.parseInt(String(req.query.limit ?? "50"), 10) || 50,
  });
  res.json({ results });
}));

router.get("/reconcile", asyncRoute(async (req, res) => {
  if (typeof req.query.q !== "string" || !req.query.q.trim()) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  const suggestions = await reconciliationSuggestions(req.query.q, req.query.kind, req.query.limit);
  res.json({ suggestions, advisory: "Similarity suggestions never merge records automatically." });
}));

router.post("/existing", asyncRoute(async (req, res) => {
  const ids = await getExistingCanonicalIds(req.body?.ids);
  res.json({ existingIds: [...ids].sort() });
}));

router.get("/nodes/:id/evidence", asyncRoute(async (req, res) => {
  const payload = await getNodeEvidence(req.params.id, true);
  if (!payload) {
    res.status(404).json({ error: "Knowledge node not found" });
    return;
  }
  res.json(payload);
}));

router.get("/nodes/:id/assessments", asyncRoute(async (req, res) => {
  const assessments = await getNodeAssessments(req.params.id, req.query.lens, true);
  res.json({ nodeId: req.params.id, assessments });
}));

router.get("/nodes/:id", asyncRoute(async (req, res) => {
  const node = await getNode(req.params.id, true);
  if (!node) {
    res.status(404).json({ error: "Knowledge node not found" });
    return;
  }
  res.json(node);
}));

router.get("/sources/:id", asyncRoute(async (req, res) => {
  const source = await getSource(req.params.id, true);
  if (!source) {
    res.status(404).json({ error: "Knowledge source not found" });
    return;
  }
  res.json(source);
}));

router.get("/neighborhood", asyncRoute(async (req, res) => {
  if (typeof req.query.nodeId !== "string" || !req.query.nodeId.trim()) {
    res.status(400).json({ error: "nodeId is required" });
    return;
  }
  const payload = await getNeighborhood(req.query.nodeId, req.query.depth, {
    lens: typeof req.query.lens === "string" ? req.query.lens : undefined,
    includeUnpublished: true,
    limit: Number.parseInt(String(req.query.limit ?? "120"), 10) || 120,
  });
  if (!payload) {
    res.status(404).json({ error: "Knowledge node not found" });
    return;
  }
  res.json(payload);
}));

router.post("/reviews", asyncRoute(async (req, res) => {
  const review = await recordReview(req.body, actor(req));
  res.status(201).json(review);
}));

router.post("/publish", asyncRoute(async (req, res) => {
  const result = await publishRevision(req.body, actor(req));
  res.json(result);
}));

export default router;
