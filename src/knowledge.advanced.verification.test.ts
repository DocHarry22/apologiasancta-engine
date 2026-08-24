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

test("public advanced routes are published-read surfaces with explicit work bounds", () => {
  for (const route of ["/timeline", "/compare/advanced", "/debate/:argumentId"]) {
    assert.ok(publicRoutes.includes(route), `missing public advanced route ${route}`);
  }
  assert.match(advancedSource, /MAX_TIMELINE = 200/);
  assert.match(advancedSource, /MAX_COMPARE_NEIGHBORS = 60/);
  assert.match(advancedSource, /MAX_PATH_DEPTH = 4/);
  assert.match(advancedSource, /MAX_PATH_EXPANDED_ROWS = 480/);
  assert.match(advancedSource, /MAX_PATH_FRONTIER = 80/);
  assert.match(advancedSource, /expandedRows < MAX_PATH_EXPANDED_ROWS/);
  assert.doesNotMatch(advancedSource, /WITH RECURSIVE walk/);
  assert.match(advancedSource, /published_revision_id IS NOT NULL/);
  assert.match(advancedSource, /undatedRecordsExcluded: true/);
  assert.match(advancedSource, /unpublishedBranchesExcluded: true/);
});

test("timeline filters explicit chronology before applying its result limit", () => {
  assert.match(advancedSource, /chronology_year IS NOT NULL/);
  assert.match(advancedSource, /chronology_year >=/);
  assert.match(advancedSource, /chronology_year <=/);
  assert.match(advancedSource, /ORDER BY chronology_year,COALESCE\(chronology_date,''\),id/);
  assert.match(advancedSource, /chronologyFilteredBeforeLimit: true/);
});

test("debate traversal uses authored argument roles rather than inferred node kinds", () => {
  assert.match(advancedSource, /String\(\(row as Row\)\.role\) === "objection"/);
  assert.doesNotMatch(advancedSource, /members\.filter\(\(row\) => String\(\(row as Row\)\.kind\) === "objection"\)/);
  assert.match(advancedSource, /authoredObjectionRoles: true/);
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

test("coverage metrics count conclusion directly and require responses only when objections exist", () => {
  assert.match(advancedSource, /criticalPublishedEdgesWithoutProvenance/);
  assert.match(advancedSource, /unansweredPublishedObjections/);
  assert.match(advancedSource, /publishedArgumentsMissingStructuralCoverage/);
  assert.match(advancedSource, /c\.id=a\.conclusion_node_id AND c\.published_revision_id IS NOT NULL/);
  assert.match(advancedSource, /m\.role='objection'/);
  assert.match(advancedSource, /m\.role IN \('response','counter_response'\)/);
  assert.match(advancedSource, /editorial QA and structural completeness, not a truth score/);
});

test("proposal acceptance requires post-proposal current unpublished governed revisions", () => {
  assert.match(advancedSource, /accepted proposals require at least one governed mutation revision ID/);
  assert.match(advancedSource, /acceptedMutationIds must contain governed revision IDs/);
  assert.match(advancedSource, /current_revision_id IS DISTINCT FROM/);
  assert.match(advancedSource, /v\.created_at >= \$2/);
  assert.match(advancedSource, /requireGovernedDraftRevisions\(client, mutationIds, row\.created_at\)/);
});
