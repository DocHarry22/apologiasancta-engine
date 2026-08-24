import assert from "node:assert/strict";
import test from "node:test";
import { KNOWLEDGE_SCHEMA_SQL, KNOWLEDGE_SCHEMA_VERSION } from "./knowledge/schema";
import { KNOWLEDGE_SCHEMA_HARDENING_SQL } from "./knowledge/schemaHardening";
import {
  canonicalId,
  KnowledgeInputError,
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

test("invalid canonical input is a client error rather than an opaque server failure", () => {
  try {
    validateNodeInput({ kind: "claim", title: "Missing proposition" });
    assert.fail("expected validation to fail");
  } catch (error) {
    assert.ok(error instanceof KnowledgeInputError);
    assert.equal(error.statusCode, 400);
  }
});

test("publication and assessment states use explicit bounded vocabularies", () => {
  assert.equal(parseContentState("published"), "published");
  assert.equal(parseAssessmentPosition("qualifies"), "qualifies");
  assert.throws(() => parseContentState("truthy"), /unsupported content state/);
});

test("schema v3 separates current authoring revisions from immutable published revisions and adds curated journeys", () => {
  assert.equal(KNOWLEDGE_SCHEMA_VERSION, 3);
  for (const required of [
    "published_revision_id",
    "node_revision_id",
    "content_hash",
    "uq_knowledge_assessment_revision_lens",
    "idx_knowledge_nodes_published_revision",
    "idx_knowledge_edges_published_revision",
    "knowledge_topics",
    "knowledge_topic_versions",
    "knowledge_topic_nodes",
    "knowledge_paths",
    "knowledge_path_versions",
    "knowledge_path_nodes",
    "knowledge_arguments",
    "knowledge_argument_versions",
    "knowledge_argument_members",
    "idx_knowledge_path_nodes_path",
    "idx_knowledge_argument_members_argument",
  ]) {
    assert.match(KNOWLEDGE_SCHEMA_SQL, new RegExp(required));
  }
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

test("database hardening prevents provenance-free edges and incompatible artifact reviews", () => {
  for (const required of [
    "knowledge_assert_edge_publication_dependencies",
    "both endpoint nodes to be published",
    "approved assertion for the published revision",
    "knowledge_assert_artifact_review_dimension",
    "knowledge_assert_citation_approval_dependencies",
    "approved citation requires its source to be published",
  ]) {
    assert.match(KNOWLEDGE_SCHEMA_HARDENING_SQL, new RegExp(required));
  }
});
