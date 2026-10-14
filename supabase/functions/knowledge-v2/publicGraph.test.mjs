import assert from "node:assert/strict";
import test from "node:test";
import { boundedInteger, neighborhood, publicPayload } from "./publicGraph.mjs";

test("Supabase responses match the graph contract and pin public revision ids", () => {
  const payload = publicPayload({
    rootNodeId: "claim:a",
    nodes: [{ id: "claim:a", current_revision_id: "draft:2", published_revision_id: "revision:1", metadata: { legacyStableKey: "root", custom_key: true } }],
    edges: [{ from_node_id: "claim:a", to_node_id: "claim:b", relationship_type: "supports" }],
  });
  assert.equal(payload.nodes[0].currentRevisionId, "revision:1");
  assert.equal(payload.nodes[0].metadata.custom_key, true);
  assert.equal(payload.edges[0].relationshipType, "supports");
  assert.equal(payload.edges[0].fromNodeId, "claim:a");
});

test("cyclic neighborhoods remain bounded and exclude unpublished endpoints", async () => {
  const all = [
    { id: "edge:ab", from_node_id: "claim:a", to_node_id: "claim:b" },
    { id: "edge:bc", from_node_id: "claim:b", to_node_id: "claim:c" },
    { id: "edge:ca", from_node_id: "claim:c", to_node_id: "claim:a" },
    { id: "edge:hidden", from_node_id: "claim:b", to_node_id: "claim:hidden" },
  ];
  let requests = 0;
  const walk = (limit) => neighborhood({ id: "claim:a" }, 3, limit,
    async ids => { requests++; return all.filter(e => ids.includes(e.from_node_id) || ids.includes(e.to_node_id)); },
    async ids => ids.filter(id => id !== "claim:hidden").map(id => ({ id })));
  const result = await walk(10);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.edges.length, 3);
  assert.equal(new Set(result.edges.map(e => e.id)).size, 3);
  assert.ok(requests <= 3);
  const capped = await walk(2);
  assert.equal(capped.nodes.length, 2);
  assert.ok(capped.edges.every(e => capped.nodes.some(n => n.id === e.from_node_id) && capped.nodes.some(n => n.id === e.to_node_id)));
});

test("invalid numbers fall back while zero depth and hard caps are preserved", () => {
  assert.equal(boundedInteger("NaN", 2, 0, 3), 2);
  assert.equal(boundedInteger("Infinity", 120, 1, 200), 120);
  assert.equal(boundedInteger("0", 2, 0, 3), 0);
  assert.equal(boundedInteger("900", 120, 1, 200), 200);
});
