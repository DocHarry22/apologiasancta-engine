import assert from "node:assert/strict";
import test from "node:test";
import { KNOWLEDGE_SCHEMA_SQL } from "./knowledge/schema";
import {
  canonicalId,
  parseAssessmentPosition,
  parseContentState,
  validateEdgeInput,
  validateNodeInput,
} from "./knowledge/validation";

test("canonical node validation requires atomic propositions for claim-like nodes", () => {
  assert.throws(() => validateNodeInput({ kind: "claim", title: "Jesus is divine" }), /require a proposition/);
  const node = validateNodeInput({
    kind: "claim",
    title: "Jesus is divine",
    proposition: "Jesus possesses the divine nature.",
    aliases: ["Divinity of Christ"],
  });
  assert.equal(node.id, "claim:jesus-is-divine");
  assert.equal(node.canonicalSlug, "jesus-is-divine");
});

test("canonical ids remain deterministic when generated from kind and slug", () => {
  assert.equal(canonicalId("claim", "John 1:1 Word is Divine"), "claim:john-1-1-word-is-divine");
});

test("relationship vocabulary rejects presentation-only arbitrary edge labels", () => {
  assert.throws(
    () => validateEdgeInput({ fromNodeId: "claim:a", toNodeId: "claim:b", relationshipType: "looks_related" }),
    /unsupported relationship type/
  );
  const edge = validateEdgeInput({ fromNodeId: "claim:a", toNodeId: "claim:b", relationshipType: "supports" });
  assert.equal(edge.relationshipType, "supports");
});

test("publication and assessment states use explicit bounded vocabularies", () => {
  assert.equal(parseContentState("published"), "published");
  assert.equal(parseAssessmentPosition("qualifies"), "qualifies");
  assert.throws(() => parseContentState("truthy"), /unsupported content state/);
});

test("schema encodes provenance, immutable revisions, review evidence, and bounded graph indexes", () => {
  for (const required of [
    "knowledge_node_versions",
    "knowledge_edge_assertions",
    "knowledge_source_versions",
    "knowledge_citations",
    "knowledge_assessments",
    "knowledge_claim_family_members",
    "knowledge_reviews",
    "knowledge_publication_events",
    "idx_knowledge_edges_from",
    "idx_knowledge_edges_to",
  ]) {
    assert.match(KNOWLEDGE_SCHEMA_SQL, new RegExp(required));
  }
});
