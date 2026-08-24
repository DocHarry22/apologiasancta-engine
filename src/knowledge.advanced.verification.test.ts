import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getAuthoringProposalProvider } from "./knowledge/advanced";
import { KNOWLEDGE_ADVANCED_SCHEMA_SQL } from "./knowledge/schemaAdvanced";

const publicRoutes = readFileSync("src/routes/knowledgeAdvanced.ts", "utf8");
const adminRoutes = readFileSync("src/routes/adminKnowledgeAdvanced.ts", "utf8");
const advancedSource = readFileSync("src/knowledge/advanced.ts", "utf8");
const appSource = readFileSync("src/app.ts", "utf8");

test("advanced schema persists proposal-only authoring assistance and bounded telemetry", () => {
  for (const required of [
    "knowledge_authoring_proposals",
    "input_hash",
    "provider",
    "accepted_mutation_ids",
    "knowledge_query_observations",
    "duration_ms",
  ]) {
    assert.match(KNOWLEDGE_ADVANCED_SCHEMA_SQL, new RegExp(required));
  }
  assert.match(KNOWLEDGE_ADVANCED_SCHEMA_SQL, /proposed','accepted','rejected','expired/);
});

test("heuristic authoring provider never auto-merges or auto-publishes", async () => {
  const provider = getAuthoringProposalProvider();
  assert.equal(provider.name, "heuristic");
  const duplicate = await provider.propose("duplicate_candidate", { text: "Jesus is divine and truly God" });
  assert.equal(duplicate.autoMerge, false);
  const claim = await provider.propose("candidate_claim", { text: "Jesus is divine." });
  assert.equal(claim.autoPublish, false);
  assert.equal(claim.requiresHumanSourceReview, true);
});

test("public advanced routes are published-read surfaces and remain bounded", () => {
  for (const route of ["/timeline", "/compare/advanced", "/debate/:argumentId"]) {
    assert.ok(publicRoutes.includes(route), `missing public advanced route ${route}`);
  }
  assert.match(advancedSource, /MAX_TIMELINE = 200/);
  assert.match(advancedSource, /MAX_COMPARE_NEIGHBORS = 60/);
  assert.match(advancedSource, /MAX_PATH_DEPTH = 4/);
  assert.match(advancedSource, /published_revision_id IS NOT NULL/);
  assert.match(advancedSource, /undatedRecordsExcluded: true/);
  assert.match(advancedSource, /unpublishedBranchesExcluded: true/);
});

test("admin coverage and proposals are protected by the existing admin boundary", () => {
  assert.match(adminRoutes, /router\.use\(requireAdmin\)/);
  assert.match(adminRoutes, /\/coverage/);
  assert.match(adminRoutes, /\/proposals/);
  assert.match(adminRoutes, /proposalOnly: true/);
  assert.match(adminRoutes, /autoPublish: false/);
  assert.match(adminRoutes, /autoMerge: false/);
  assert.match(appSource, /\/admin\/knowledge\/advanced/);
});

test("coverage metrics explicitly avoid truth scoring and surface provenance failures", () => {
  assert.match(advancedSource, /criticalPublishedEdgesWithoutProvenance/);
  assert.match(advancedSource, /unansweredPublishedObjections/);
  assert.match(advancedSource, /publishedArgumentsMissingStructuralCoverage/);
  assert.match(advancedSource, /editorial QA and structural completeness, not a truth score/);
});
