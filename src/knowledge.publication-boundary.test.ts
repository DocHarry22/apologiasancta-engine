import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { KNOWLEDGE_SCHEMA_HARDENING_SQL } from "./knowledge/schemaHardening";
import {
  parseAuthoringContentState,
  parseContentState,
  validateEdgeInput,
  validateNodeInput,
} from "./knowledge/validation";

const repositorySource = readFileSync("src/knowledge/repository.ts", "utf8");

test("published remains a known stored state but is rejected from ordinary authoring payloads", () => {
  assert.equal(parseContentState("published"), "published");
  assert.throws(
    () => parseAuthoringContentState("published"),
    /published state can only be reached through the governed publication endpoint/
  );
  assert.throws(
    () => validateNodeInput({
      kind: "claim",
      title: "Reviewed claim",
      proposition: "A proposition that has not yet passed this revision's reviews.",
      contentState: "published",
    }),
    /governed publication endpoint/
  );
  assert.throws(
    () => validateEdgeInput({
      fromNodeId: "claim:source",
      toNodeId: "claim:target",
      relationshipType: "supports",
      contentState: "published",
    }),
    /governed publication endpoint/
  );
});

test("published records retain their immutable public revision while edits return to review", () => {
  assert.match(
    repositorySource,
    /patch\.contentState \?\? \(current\.contentState === "published" \? "draft" : current\.contentState\)/
  );
  assert.match(
    repositorySource,
    /if \(existing\.published_revision_id\)[\s\S]*UPDATE knowledge_nodes SET current_revision_id=\$2,updated_at=NOW\(\) WHERE id=\$1/
  );
  assert.match(
    repositorySource,
    /if \(row\.published_revision_id\)[\s\S]*UPDATE knowledge_edges SET current_revision_id=\$2,updated_at=NOW\(\) WHERE id=\$1/
  );
  assert.match(
    repositorySource,
    /if \(row\.published_revision_id\)[\s\S]*UPDATE knowledge_sources SET current_revision_id=\$2,updated_at=NOW\(\) WHERE id=\$1/
  );
});

test("public assessment reads require the published node revision and approved assessment state", () => {
  assert.match(repositorySource, /export async function getNodeAssessments/);
  assert.match(repositorySource, /const node = await getNode\(idValue, includeUnpublished\)/);
  assert.match(repositorySource, /includeUnpublished \? node\.currentRevisionId : node\.publishedRevisionId/);
  assert.match(repositorySource, /includeUnpublished \? "" : "AND review_state='approved'"/);
});

test("database publication guard requires evidence-backed edge assertions", () => {
  for (const required of [
    "jsonb_array_length(a.source_ids) > 0",
    "knowledge_citations c",
    "c.edge_assertion_id = a.id",
    "c.review_state = 'approved'",
    "s.published_revision_id IS NOT NULL",
    "approved attributable assertion with published source evidence and an approved citation",
  ]) {
    assert.ok(KNOWLEDGE_SCHEMA_HARDENING_SQL.includes(required), `missing hardening clause: ${required}`);
  }
});

test("source authoring keeps the existing repository-level direct publication guard", () => {
  assert.match(repositorySource, /export async function createSource[\s\S]*ensureNotDirectlyPublished\(snapshot\.contentState\)/);
  assert.match(repositorySource, /export async function reviseSource[\s\S]*ensureNotDirectlyPublished\(snapshot\.contentState\)/);
});
