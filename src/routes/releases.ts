import { Router, Request, Response } from "express";
import { requireAdmin } from "./admin";
import { createRelease, listReleases, markReleaseRead, validateReleaseInput } from "../state/releases";

export const releasesRouter = Router();
export const adminReleasesRouter = Router();

function pagination(req: Request) {
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize || "20"), 10) || 20));
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  return { page, pageSize, search };
}

releasesRouter.get("/", async (req: Request, res: Response) => {
  try {
    res.json(await listReleases(pagination(req)));
  } catch {
    res.status(503).json({ error: "Release archive unavailable" });
  }
});

releasesRouter.get("/latest", async (_req: Request, res: Response) => {
  try {
    const result = await listReleases({ page: 1, pageSize: 1 });
    res.json({ release: result.items[0] ?? null });
  } catch {
    res.status(503).json({ error: "Release archive unavailable" });
  }
});

adminReleasesRouter.use(requireAdmin);

adminReleasesRouter.get("/", async (req: Request, res: Response) => {
  try {
    res.json(await listReleases(pagination(req)));
  } catch {
    res.status(503).json({ error: "Release archive unavailable" });
  }
});

adminReleasesRouter.post("/", async (req: Request, res: Response) => {
  const validated = validateReleaseInput(req.body);
  if (!validated.ok) return res.status(400).json({ error: validated.error });
  try {
    const result = await createRelease(validated.value);
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Release creation failed" });
  }
});

adminReleasesRouter.patch("/:id/read", async (req: Request<{ id: string }>, res: Response) => {
  const read = req.body?.read;
  if (typeof read !== "boolean") return res.status(400).json({ error: "Boolean read field required" });
  try {
    const record = await markReleaseRead(req.params.id, read);
    if (!record) return res.status(404).json({ error: "Release not found" });
    return res.json({ record });
  } catch {
    return res.status(500).json({ error: "Unable to update release" });
  }
});
