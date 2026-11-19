import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { boundedInteger, neighborhood, publicPayload } from "./publicGraph.mjs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
function handler(tables) {
  let serve;
  const db = { from(table) {
    let rows = tables[table] || [], single = false, countOnly = false, cap = Infinity;
    const query = {
      select(_fields, options) { countOnly = options?.head; return query; },
      eq(key, value) { rows = rows.filter(row => row[key] === value); return query; },
      not(key, _op, value) { rows = rows.filter(row => row[key] !== value && row[key] !== undefined); return query; },
      in(key, values) { rows = rows.filter(row => values.includes(row[key])); return query; },
      or() { return query; },
      order(key) { rows = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key]))); return query; },
      limit(value) { cap = value; return query; },
      maybeSingle() { single = true; return query; },
      then(resolve, reject) { return Promise.resolve({ data: countOnly ? null : single ? rows[0] || null : rows.slice(0, cap), count: rows.length, error: null }).then(resolve, reject); }
    };
    return query;
  } };
  const deno = { env: { get: key => key === "SUPABASE_URL" ? "https://project.test" : key === "SUPABASE_SERVICE_ROLE_KEY" ? "test-only" : undefined }, serve: callback => { serve = callback; } };
  new Function("createClient", "Deno", "boundedInteger", "neighborhood", "publicPayload", compiled)(() => db, deno, boundedInteger, neighborhood, publicPayload);
  return serve;
}
const node = { id: "claim:a", kind: "claim", title: "A", content_state: "published", published_revision_id: "revision:1", current_revision_id: "draft:2" };
test("deployed handler returns graph DTOs and only revision-matching approved provenance", async () => {
  const handle = handler({
    knowledge_nodes: [node, { ...node, id: "claim:b" }],
    knowledge_edges: [{ id: "edge:ab", from_node_id: "claim:a", to_node_id: "claim:b", relationship_type: "supports", published_revision_id: "edge-revision:1" }],
    knowledge_edge_assertions: [
      { id: "assertion:valid", edge_id: "edge:ab", revision_id: "edge-revision:1", review_state: "approved" },
      { id: "assertion:old", edge_id: "edge:ab", revision_id: "edge-revision:0", review_state: "approved" }
    ],
    knowledge_assessments: [{ id: "assessment:valid", node_id: "claim:a", node_revision_id: "revision:1", lens: "catholic", review_state: "approved" }]
  });
  const response = await handle(new Request("https://project.test/functions/v1/knowledge-v2/neighborhood?nodeId=claim:a&depth=NaN&lens=catholic"));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.edges[0].relationshipType, "supports");
  assert.equal(result.nodes[0].currentRevisionId, "revision:1");
  assert.equal(result.assertions.length, 1);
  assert.equal(result.assessments.length, 1);
  assert.equal(result.depth, 2);
});
test("evidence excludes superseded citations and unpublished sources", async () => {
  const handle = handler({
    knowledge_nodes: [node],
    knowledge_citations: [
      { id: "citation:valid", node_id: node.id, node_revision_id: "revision:1", source_id: "source:valid", review_state: "approved" },
      { id: "citation:old", node_id: node.id, node_revision_id: "revision:0", source_id: "source:valid", review_state: "approved" },
      { id: "citation:hidden", node_id: node.id, node_revision_id: "revision:1", source_id: "source:hidden", review_state: "approved" }
    ],
    knowledge_sources: [{ id: "source:valid", published_revision_id: "source-revision:1" }, { id: "source:hidden", published_revision_id: null }]
  });
  const result = await (await handle(new Request("https://project.test/knowledge-v2/nodes/claim%3Aa/evidence"))).json();
  assert.equal(result.node.id, node.id);
  assert.deepEqual(result.citations.map(c => c.id), ["citation:valid"]);
  assert.equal(result.sources.length, 1);
});
test("malformed encodings and filter syntax fail safely without cacheable errors", async () => {
  const handle = handler({});
  for (const path of ["nodes/%ZZ", "search?q=a%2Cb"]) {
    const response = await handle(new Request("https://project.test/knowledge-v2/" + path));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
