import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAdmin } from "./admin";
import {
  createAuthoringProposal,
  decideAuthoringProposal,
  getCoverageDashboard,
  listAuthoringProposals,
} from "../knowledge/advanced";

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

router.get("/coverage", asyncRoute(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await getCoverageDashboard());
}));

router.get("/proposals", asyncRoute(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const proposals = await listAuthoringProposals({
    status: req.query.status,
    type: req.query.type,
    limit: req.query.limit,
  });
  res.json({ proposals, proposalOnly: true, autoPublish: false, autoMerge: false });
}));

router.post("/proposals", asyncRoute(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const proposal = await createAuthoringProposal(req.body, actor(req));
  res.status(201).json({ proposal, proposalOnly: true, autoPublish: false, autoMerge: false });
}));

router.post("/proposals/:id/decision", asyncRoute(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const proposal = await decideAuthoringProposal(req.params.id, req.body, actor(req));
  if (!proposal) {
    res.status(404).json({ error: "Authoring proposal not found" });
    return;
  }
  res.json({
    proposal,
    publicationBoundary: "Accepted proposals must reference current unpublished governed revisions; those revisions still require ordinary review and publication gates.",
  });
}));

export default router;
