import type { PoolClient } from "pg";
import { queryKnowledge, withKnowledgeTransaction } from "./db";
import type {
  EdgeAssertion,
  KnowledgeAssessment,
  KnowledgeCitation,
  KnowledgeEdge,
  KnowledgeNode,
  KnowledgeSource,
  NeighborhoodPayload,
} from "./types";
import {
  asMetadata,
  asStringArray,
  assertCanonicalId,
  objectId,
  optionalText,
  parseAssessmentPosition,
  parseContentState,
  requireObject,
  requireText,
  revisionId,
  stableHash,
  validateEdgeInput,
  validateNodeInput,
} from "./validation";

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function nodeFromRow(row: Row): KnowledgeNode {
  return {
    id: String(row.id),
    kind: row.kind as KnowledgeNode["kind"],
    canonicalSlug: String(row.canonical_slug),
    title: String(row.title),
    ...(row.proposition ? { proposition: String(row.proposition) } : {}),
    ...(row.summary ? { summary: String(row.summary) } : {}),
    ...(row.language ? { language: String(row.language) } : {}),
    contentState: row.content_state as KnowledgeNode["contentState"],
    currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null,
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function edgeFromRow(row: Row): KnowledgeEdge {
  return {
    id: String(row.id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    relationshipType: row.relationship_type as KnowledgeEdge["relationshipType"],
    contentState: row.content_state as KnowledgeEdge["contentState"],
    currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null,
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function assertionFromRow(row: Row): EdgeAssertion {
  return {
    id: String(row.id),
    edgeId: String(row.edge_id),
    assertedByType: String(row.asserted_by_type),
    assertedById: String(row.asserted_by_id),
    stance: String(row.stance),
    sourceIds: jsonStrings(row.source_ids),
    attributionMode: String(row.attribution_mode),
    confidence: String(row.confidence),
    reviewState: String(row.review_state),
    ...(row.revision_id ? { revisionId: String(row.revision_id) } : {}),
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
  };
}

function assessmentFromRow(row: Row): KnowledgeAssessment {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    lens: String(row.lens),
    position: row.position as KnowledgeAssessment["position"],
    rationaleIds: jsonStrings(row.rationale_ids),
    sourceIds: jsonStrings(row.source_ids),
    reviewState: String(row.review_state),
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function sourceFromRow(row: Row): KnowledgeSource {
  return {
    id: String(row.id),
    sourceType: String(row.source_type),
    title: String(row.title),
    ...(row.author ? { author: String(row.author) } : {}),
    ...(row.edition ? { edition: String(row.edition) } : {}),
    ...(row.language ? { language: String(row.language) } : {}),
    ...(row.authority_class ? { authorityClass: String(row.authority_class) } : {}),
    ...(row.binding_status ? { bindingStatus: String(row.binding_status) } : {}),
    ...(row.licensing_status ? { licensingStatus: String(row.licensing_status) } : {}),
    contentState: row.content_state as KnowledgeSource["contentState"],
    currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null,
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function citationFromRow(row: Row): KnowledgeCitation {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    ...(row.node_id ? { nodeId: String(row.node_id) } : {}),
    ...(row.edge_assertion_id ? { edgeAssertionId: String(row.edge_assertion_id) } : {}),
    locator: String(row.locator),
    ...(row.fragment ? { fragment: String(row.fragment) } : {}),
    fragmentMode: String(row.fragment_mode),
    attributionMode: String(row.attribution_mode),
    reviewState: String(row.review_state),
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
  };
}

async function nextVersion(client: PoolClient, table: string, idColumn: string, id: string): Promise<number> {
  const result = await client.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM ${table} WHERE ${idColumn} = $1`,
    [id]
  );
  return Number(result.rows[0]?.next_version ?? 1);
}

export async function createNode(value: unknown, actor: string): Promise<KnowledgeNode> {
  const node = validateNodeInput(value);
  return withKnowledgeTransaction(async (client) => {
    const snapshot = { ...node, aliases: undefined };
    const rev = revisionId("node");
    const hash = stableHash(snapshot);
    await client.query(
      `INSERT INTO knowledge_nodes
       (id, kind, canonical_slug, title, proposition, summary, language, content_state, current_revision_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [node.id, node.kind, node.canonicalSlug, node.title, node.proposition ?? null, node.summary ?? null, node.language ?? null, node.contentState, rev, JSON.stringify(node.metadata)]
    );
    await client.query(
      `INSERT INTO knowledge_node_versions(revision_id,node_id,version,content_hash,snapshot,created_by)
       VALUES ($1,$2,1,$3,$4::jsonb,$5)`,
      [rev, node.id, hash, JSON.stringify(snapshot), actor]
    );
    for (const alias of [...new Set(node.aliases)]) {
      await client.query(
        `INSERT INTO knowledge_node_aliases(node_id,alias,alias_type,provenance)
         VALUES($1,$2,'search',$3::jsonb) ON CONFLICT DO NOTHING`,
        [node.id, alias, JSON.stringify({ actor })]
      );
    }
    const result = await client.query(`SELECT * FROM knowledge_nodes WHERE id = $1`, [node.id]);
    return nodeFromRow(result.rows[0] as Row);
  });
}

export async function reviseNode(idValue: unknown, patchValue: unknown, actor: string): Promise<KnowledgeNode> {
  const id = assertCanonicalId(idValue);
  const patch = requireObject(patchValue);
  return withKnowledgeTransaction(async (client) => {
    const existingResult = await client.query(`SELECT * FROM knowledge_nodes WHERE id = $1 FOR UPDATE`, [id]);
    const existing = existingResult.rows[0] as Row | undefined;
    if (!existing) throw new Error("Knowledge node not found");
    const current = nodeFromRow(existing);
    const merged = validateNodeInput({
      id: current.id,
      kind: patch.kind ?? current.kind,
      canonicalSlug: patch.canonicalSlug ?? current.canonicalSlug,
      title: patch.title ?? current.title,
      proposition: patch.proposition ?? current.proposition,
      summary: patch.summary ?? current.summary,
      language: patch.language ?? current.language,
      contentState: patch.contentState ?? current.contentState,
      metadata: patch.metadata ?? current.metadata,
      aliases: patch.aliases ?? [],
    });
    const rev = revisionId("node");
    const version = await nextVersion(client, "knowledge_node_versions", "node_id", id);
    const snapshot = { ...merged, aliases: undefined };
    const hash = stableHash(snapshot);
    await client.query(
      `INSERT INTO knowledge_node_versions(revision_id,node_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [rev, id, version, hash, JSON.stringify(snapshot), actor]
    );
    await client.query(
      `UPDATE knowledge_nodes SET kind=$2, canonical_slug=$3, title=$4, proposition=$5, summary=$6,
       language=$7, content_state=$8, current_revision_id=$9, metadata=$10::jsonb, updated_at=NOW()
       WHERE id=$1`,
      [id, merged.kind, merged.canonicalSlug, merged.title, merged.proposition ?? null, merged.summary ?? null, merged.language ?? null, merged.contentState, rev, JSON.stringify(merged.metadata)]
    );
    for (const alias of [...new Set(merged.aliases)]) {
      await client.query(
        `INSERT INTO knowledge_node_aliases(node_id,alias,alias_type,provenance)
         VALUES($1,$2,'search',$3::jsonb) ON CONFLICT DO NOTHING`,
        [id, alias, JSON.stringify({ actor })]
      );
    }
    const result = await client.query(`SELECT * FROM knowledge_nodes WHERE id = $1`, [id]);
    return nodeFromRow(result.rows[0] as Row);
  });
}

export async function createEdge(value: unknown, actor: string): Promise<KnowledgeEdge> {
  const edge = validateEdgeInput(value);
  return withKnowledgeTransaction(async (client) => {
    const rev = revisionId("edge");
    const hash = stableHash(edge);
    await client.query(
      `INSERT INTO knowledge_edges(id,from_node_id,to_node_id,relationship_type,content_state,current_revision_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [edge.id, edge.fromNodeId, edge.toNodeId, edge.relationshipType, edge.contentState, rev, JSON.stringify(edge.metadata)]
    );
    await client.query(
      `INSERT INTO knowledge_edge_versions(revision_id,edge_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,1,$3,$4::jsonb,$5)`,
      [rev, edge.id, hash, JSON.stringify(edge), actor]
    );
    const result = await client.query(`SELECT * FROM knowledge_edges WHERE id=$1`, [edge.id]);
    return edgeFromRow(result.rows[0] as Row);
  });
}

export async function createEdgeAssertion(value: unknown): Promise<EdgeAssertion> {
  const input = requireObject(value);
  const edgeId = assertCanonicalId(input.edgeId, "edgeId");
  const id = input.id ? assertCanonicalId(input.id) : objectId("assertion");
  const assertedByType = requireText(input.assertedByType, "assertedByType", 80);
  const assertedById = requireText(input.assertedById, "assertedById", 200);
  const stance = requireText(input.stance, "stance", 80);
  const attributionMode = requireText(input.attributionMode, "attributionMode", 80);
  const confidence = optionalText(input.confidence, "confidence", 80) ?? "unresolved";
  const reviewState = optionalText(input.reviewState, "reviewState", 80) ?? "awaiting_review";
  const sourceIds = asStringArray(input.sourceIds, "sourceIds", 50);
  const metadata = asMetadata(input.metadata);
  const rows = await queryKnowledge(
    `INSERT INTO knowledge_edge_assertions
     (id,edge_id,asserted_by_type,asserted_by_id,stance,source_ids,attribution_mode,confidence,review_state,revision_id,metadata)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb)
     RETURNING *`,
    [id, edgeId, assertedByType, assertedById, stance, JSON.stringify(sourceIds), attributionMode, confidence, reviewState, optionalText(input.revisionId, "revisionId", 200) ?? null, JSON.stringify(metadata)]
  );
  return assertionFromRow(rows[0] as Row);
}

export async function createSource(value: unknown, actor: string): Promise<KnowledgeSource> {
  const input = requireObject(value);
  const sourceType = requireText(input.sourceType, "sourceType", 80);
  const title = requireText(input.title, "title", 500);
  const id = input.id ? assertCanonicalId(input.id) : `source:${stableHash({ sourceType, title, author: input.author ?? "" }).slice(0, 24)}`;
  const snapshot = {
    id,
    sourceType,
    title,
    author: optionalText(input.author, "author", 300),
    edition: optionalText(input.edition, "edition", 500),
    language: optionalText(input.language, "language", 40),
    authorityClass: optionalText(input.authorityClass, "authorityClass", 100),
    bindingStatus: optionalText(input.bindingStatus, "bindingStatus", 100),
    licensingStatus: optionalText(input.licensingStatus, "licensingStatus", 100) ?? "unknown",
    contentState: parseContentState(input.contentState),
    metadata: asMetadata(input.metadata),
  };
  return withKnowledgeTransaction(async (client) => {
    const rev = revisionId("source");
    await client.query(
      `INSERT INTO knowledge_sources
       (id,source_type,title,author,edition,language,authority_class,binding_status,licensing_status,content_state,current_revision_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [id, sourceType, title, snapshot.author ?? null, snapshot.edition ?? null, snapshot.language ?? null, snapshot.authorityClass ?? null, snapshot.bindingStatus ?? null, snapshot.licensingStatus, snapshot.contentState, rev, JSON.stringify(snapshot.metadata)]
    );
    await client.query(
      `INSERT INTO knowledge_source_versions(revision_id,source_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,1,$3,$4::jsonb,$5)`,
      [rev, id, stableHash(snapshot), JSON.stringify(snapshot), actor]
    );
    const result = await client.query(`SELECT * FROM knowledge_sources WHERE id=$1`, [id]);
    return sourceFromRow(result.rows[0] as Row);
  });
}

export async function createCitation(value: unknown): Promise<KnowledgeCitation> {
  const input = requireObject(value);
  const id = input.id ? assertCanonicalId(input.id) : objectId("citation");
  const sourceId = assertCanonicalId(input.sourceId, "sourceId");
  const nodeId = input.nodeId ? assertCanonicalId(input.nodeId, "nodeId") : undefined;
  const edgeAssertionId = input.edgeAssertionId ? assertCanonicalId(input.edgeAssertionId, "edgeAssertionId") : undefined;
  if (!nodeId && !edgeAssertionId) throw new Error("citation requires nodeId or edgeAssertionId");
  const locator = requireText(input.locator, "locator", 1000);
  const fragment = optionalText(input.fragment, "fragment", 20_000);
  const fragmentMode = optionalText(input.fragmentMode, "fragmentMode", 80) ?? "reference_only";
  const attributionMode = optionalText(input.attributionMode, "attributionMode", 80) ?? "source";
  const reviewState = optionalText(input.reviewState, "reviewState", 80) ?? "unverified";
  const metadata = asMetadata(input.metadata);
  const rows = await queryKnowledge(
    `INSERT INTO knowledge_citations
     (id,source_id,node_id,edge_assertion_id,locator,fragment,fragment_mode,attribution_mode,content_hash,review_state,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
    [id, sourceId, nodeId ?? null, edgeAssertionId ?? null, locator, fragment ?? null, fragmentMode, attributionMode, fragment ? stableHash(fragment) : null, reviewState, JSON.stringify(metadata)]
  );
  return citationFromRow(rows[0] as Row);
}

export async function upsertAssessment(value: unknown): Promise<KnowledgeAssessment> {
  const input = requireObject(value);
  const nodeId = assertCanonicalId(input.nodeId, "nodeId");
  const lens = requireText(input.lens, "lens", 120).toLowerCase();
  const position = parseAssessmentPosition(input.position);
  const rationaleIds = asStringArray(input.rationaleIds, "rationaleIds", 50);
  const sourceIds = asStringArray(input.sourceIds, "sourceIds", 50);
  const reviewState = optionalText(input.reviewState, "reviewState", 80) ?? "awaiting_review";
  const metadata = asMetadata(input.metadata);
  const id = input.id ? assertCanonicalId(input.id) : `assessment:${stableHash({ nodeId, lens }).slice(0, 24)}`;
  const rows = await queryKnowledge(
    `INSERT INTO knowledge_assessments(id,node_id,lens,position,rationale_ids,source_ids,review_state,metadata)
     VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb)
     ON CONFLICT(node_id,lens) DO UPDATE SET position=EXCLUDED.position,rationale_ids=EXCLUDED.rationale_ids,
       source_ids=EXCLUDED.source_ids,review_state=EXCLUDED.review_state,metadata=EXCLUDED.metadata,updated_at=NOW()
     RETURNING *`,
    [id, nodeId, lens, position, JSON.stringify(rationaleIds), JSON.stringify(sourceIds), reviewState, JSON.stringify(metadata)]
  );
  return assessmentFromRow(rows[0] as Row);
}

export async function addClaimFamilyMember(value: unknown, actor: string): Promise<void> {
  const input = requireObject(value);
  const familyNodeId = assertCanonicalId(input.familyNodeId, "familyNodeId");
  const claimNodeId = assertCanonicalId(input.claimNodeId, "claimNodeId");
  const relation = optionalText(input.relation, "relation", 80) ?? "member";
  await queryKnowledge(
    `INSERT INTO knowledge_claim_family_members(family_node_id,claim_node_id,relation,created_by)
     VALUES($1,$2,$3,$4) ON CONFLICT(family_node_id,claim_node_id) DO UPDATE SET relation=EXCLUDED.relation`,
    [familyNodeId, claimNodeId, relation, actor]
  );
}

export async function getNode(idValue: unknown, includeUnpublished = false): Promise<KnowledgeNode | null> {
  const id = assertCanonicalId(idValue);
  const rows = await queryKnowledge(
    `SELECT * FROM knowledge_nodes WHERE id=$1 ${includeUnpublished ? "" : "AND content_state='published'"}`,
    [id]
  );
  return rows[0] ? nodeFromRow(rows[0] as Row) : null;
}

export async function getNeighborhood(
  idValue: unknown,
  depthValue: unknown,
  options: { lens?: string; includeUnpublished?: boolean; limit?: number } = {}
): Promise<NeighborhoodPayload | null> {
  const rootNodeId = assertCanonicalId(idValue);
  const depthNumber = typeof depthValue === "number" ? depthValue : Number.parseInt(String(depthValue ?? "2"), 10);
  const depth = Math.max(0, Math.min(3, Number.isFinite(depthNumber) ? depthNumber : 2));
  const limit = Math.max(1, Math.min(250, options.limit ?? 120));
  const stateClause = options.includeUnpublished ? "" : "AND e.content_state = 'published'";
  const nodeStateClause = options.includeUnpublished ? "" : "AND n.content_state = 'published'";
  const root = await getNode(rootNodeId, options.includeUnpublished);
  if (!root) return null;

  const walkRows = await queryKnowledge<{ node_id: string; depth: number }>(
    `WITH RECURSIVE walk(node_id, depth, path) AS (
       SELECT $1::text, 0, ARRAY[$1::text]
       UNION ALL
       SELECT CASE WHEN e.from_node_id = w.node_id THEN e.to_node_id ELSE e.from_node_id END,
              w.depth + 1,
              w.path || CASE WHEN e.from_node_id = w.node_id THEN e.to_node_id ELSE e.from_node_id END
       FROM walk w
       JOIN knowledge_edges e ON (e.from_node_id = w.node_id OR e.to_node_id = w.node_id)
       WHERE w.depth < $2 ${stateClause}
         AND NOT (CASE WHEN e.from_node_id = w.node_id THEN e.to_node_id ELSE e.from_node_id END = ANY(w.path))
     )
     SELECT node_id, MIN(depth)::int AS depth FROM walk GROUP BY node_id ORDER BY MIN(depth), node_id LIMIT $3`,
    [rootNodeId, depth, limit]
  );
  const nodeIds = walkRows.map((row) => row.node_id);
  const nodeRows = await queryKnowledge(
    `SELECT n.* FROM knowledge_nodes n WHERE n.id = ANY($1::text[]) ${nodeStateClause} ORDER BY n.id`,
    [nodeIds]
  );
  const edgeRows = await queryKnowledge(
    `SELECT e.* FROM knowledge_edges e
     WHERE e.from_node_id = ANY($1::text[]) AND e.to_node_id = ANY($1::text[])
     ${options.includeUnpublished ? "" : "AND e.content_state='published'"}
     ORDER BY e.id LIMIT $2`,
    [nodeIds, limit * 3]
  );
  const edgeIds = edgeRows.map((row) => String((row as Row).id));
  const assertionRows = edgeIds.length > 0
    ? await queryKnowledge(`SELECT * FROM knowledge_edge_assertions WHERE edge_id = ANY($1::text[]) ORDER BY created_at`, [edgeIds])
    : [];
  const lens = options.lens?.trim().toLowerCase();
  const assessmentRows = nodeIds.length > 0
    ? await queryKnowledge(
        `SELECT * FROM knowledge_assessments WHERE node_id = ANY($1::text[]) ${lens ? "AND lens=$2" : ""} ORDER BY node_id,lens`,
        lens ? [nodeIds, lens] : [nodeIds]
      )
    : [];
  return {
    rootNodeId,
    depth,
    nodes: nodeRows.map((row) => nodeFromRow(row as Row)),
    edges: edgeRows.map((row) => edgeFromRow(row as Row)),
    assertions: assertionRows.map((row) => assertionFromRow(row as Row)),
    assessments: assessmentRows.map((row) => assessmentFromRow(row as Row)),
  };
}

export async function getNodeEvidence(idValue: unknown, includeUnpublished = false) {
  const node = await getNode(idValue, includeUnpublished);
  if (!node) return null;
  const citations = await queryKnowledge(
    `SELECT c.* FROM knowledge_citations c JOIN knowledge_sources s ON s.id=c.source_id
     WHERE c.node_id=$1 ${includeUnpublished ? "" : "AND s.content_state='published'"}
     ORDER BY c.created_at`,
    [node.id]
  );
  const sourceIds = [...new Set(citations.map((row) => String((row as Row).source_id)))];
  const sources = sourceIds.length
    ? await queryKnowledge(`SELECT * FROM knowledge_sources WHERE id=ANY($1::text[]) ORDER BY title`, [sourceIds])
    : [];
  return {
    node,
    citations: citations.map((row) => citationFromRow(row as Row)),
    sources: sources.map((row) => sourceFromRow(row as Row)),
  };
}

export async function getNodeAssessments(idValue: unknown, lensValue?: unknown) {
  const id = assertCanonicalId(idValue);
  const lens = typeof lensValue === "string" && lensValue.trim() ? lensValue.trim().toLowerCase() : null;
  const rows = await queryKnowledge(
    `SELECT * FROM knowledge_assessments WHERE node_id=$1 ${lens ? "AND lens=$2" : ""} ORDER BY lens`,
    lens ? [id, lens] : [id]
  );
  return rows.map((row) => assessmentFromRow(row as Row));
}

export async function searchKnowledge(queryValue: unknown, options: { kind?: string; includeUnpublished?: boolean; limit?: number } = {}) {
  const query = requireText(queryValue, "q", 500);
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  const exact = query.toLowerCase();
  const pattern = `%${exact}%`;
  const params: unknown[] = [pattern, exact];
  let kindClause = "";
  if (options.kind) {
    params.push(options.kind);
    kindClause = `AND n.kind=$${params.length}`;
  }
  params.push(limit);
  const rows = await queryKnowledge(
    `SELECT DISTINCT n.*,
      CASE WHEN LOWER(n.title)=$2 THEN 0 WHEN LOWER(n.title) LIKE $1 THEN 1 ELSE 2 END AS rank_hint
     FROM knowledge_nodes n
     LEFT JOIN knowledge_node_aliases a ON a.node_id=n.id
     WHERE (LOWER(n.title) LIKE $1 OR LOWER(COALESCE(n.proposition,'')) LIKE $1 OR LOWER(COALESCE(a.alias,'')) LIKE $1)
       ${options.includeUnpublished ? "" : "AND n.content_state='published'"} ${kindClause}
     ORDER BY rank_hint, n.title LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => nodeFromRow(row as Row));
}

export async function reconciliationSuggestions(queryValue: unknown, kindValue?: unknown, limitValue?: unknown) {
  const query = requireText(queryValue, "q", 500);
  const kind = typeof kindValue === "string" && kindValue.trim() ? kindValue.trim() : undefined;
  const limit = Math.max(1, Math.min(30, Number.parseInt(String(limitValue ?? "12"), 10) || 12));
  const tokens = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3))].slice(0, 12);
  const rows = await queryKnowledge(
    `SELECT n.*,
      (CASE WHEN LOWER(n.title)=LOWER($1) THEN 100 ELSE 0 END
       + CASE WHEN LOWER(n.title) LIKE '%' || LOWER($1) || '%' THEN 35 ELSE 0 END
       + CASE WHEN LOWER(COALESCE(n.proposition,'')) LIKE '%' || LOWER($1) || '%' THEN 25 ELSE 0 END
       + (SELECT COUNT(*)::int * 5 FROM unnest($2::text[]) t WHERE LOWER(n.title || ' ' || COALESCE(n.proposition,'')) LIKE '%' || t || '%')
      ) AS lexical_score
     FROM knowledge_nodes n
     WHERE ($3::text IS NULL OR n.kind=$3)
     ORDER BY lexical_score DESC, n.updated_at DESC
     LIMIT $4`,
    [query, tokens, kind ?? null, limit]
  );
  return rows
    .map((row) => ({ node: nodeFromRow(row as Row), score: Number((row as Row).lexical_score ?? 0) }))
    .filter((entry) => entry.score > 0);
}

export async function compareNodes(leftValue: unknown, rightValue: unknown) {
  const left = assertCanonicalId(leftValue, "left");
  const right = assertCanonicalId(rightValue, "right");
  const nodes = await queryKnowledge(`SELECT * FROM knowledge_nodes WHERE id=ANY($1::text[]) AND content_state='published'`, [[left, right]]);
  if (nodes.length !== 2) return null;
  const directEdges = await queryKnowledge(
    `SELECT * FROM knowledge_edges WHERE content_state='published' AND ((from_node_id=$1 AND to_node_id=$2) OR (from_node_id=$2 AND to_node_id=$1))`,
    [left, right]
  );
  const shared = await queryKnowledge(
    `WITH left_neighbors AS (
       SELECT CASE WHEN from_node_id=$1 THEN to_node_id ELSE from_node_id END AS node_id
       FROM knowledge_edges WHERE content_state='published' AND (from_node_id=$1 OR to_node_id=$1)
     ), right_neighbors AS (
       SELECT CASE WHEN from_node_id=$2 THEN to_node_id ELSE from_node_id END AS node_id
       FROM knowledge_edges WHERE content_state='published' AND (from_node_id=$2 OR to_node_id=$2)
     )
     SELECT n.* FROM knowledge_nodes n
     JOIN left_neighbors l ON l.node_id=n.id JOIN right_neighbors r ON r.node_id=n.id
     WHERE n.content_state='published' ORDER BY n.title LIMIT 50`,
    [left, right]
  );
  return {
    left: nodeFromRow(nodes.find((row) => String((row as Row).id) === left) as Row),
    right: nodeFromRow(nodes.find((row) => String((row as Row).id) === right) as Row),
    directEdges: directEdges.map((row) => edgeFromRow(row as Row)),
    sharedNeighbors: shared.map((row) => nodeFromRow(row as Row)),
  };
}

export async function publishRevision(value: unknown, actor: string) {
  const input = requireObject(value);
  const targetType = requireText(input.targetType, "targetType", 40);
  if (!["node", "edge", "source"].includes(targetType)) throw new Error("targetType must be node, edge, or source");
  const targetId = assertCanonicalId(input.targetId, "targetId");
  const revision = requireText(input.revisionId, "revisionId", 250);
  const table = targetType === "node" ? "knowledge_node_versions" : targetType === "edge" ? "knowledge_edge_versions" : "knowledge_source_versions";
  const idColumn = targetType === "node" ? "node_id" : targetType === "edge" ? "edge_id" : "source_id";
  const targetTable = targetType === "node" ? "knowledge_nodes" : targetType === "edge" ? "knowledge_edges" : "knowledge_sources";
  return withKnowledgeTransaction(async (client) => {
    const revisionRows = await client.query(`SELECT content_hash FROM ${table} WHERE revision_id=$1 AND ${idColumn}=$2`, [revision, targetId]);
    const contentHash = String((revisionRows.rows[0] as Row | undefined)?.content_hash ?? "");
    if (!contentHash) throw new Error("revision not found for target");
    const reviews = await client.query(
      `SELECT review_dimension,state,content_hash FROM knowledge_reviews WHERE target_revision_id=$1`,
      [revision]
    );
    const requiredDimensions = targetType === "source" ? ["source"] : ["source", "doctrinal"];
    for (const dimension of requiredDimensions) {
      const approved = reviews.rows.some((row) => row.review_dimension === dimension && row.state === "approved" && row.content_hash === contentHash);
      if (!approved) throw new Error(`publication requires approved ${dimension} review bound to this revision hash`);
    }
    const update = await client.query(`UPDATE ${targetTable} SET content_state='published',updated_at=NOW() WHERE id=$1 AND current_revision_id=$2 RETURNING id`, [targetId, revision]);
    if (update.rowCount !== 1) throw new Error("target revision is no longer current");
    const eventId = objectId("publication");
    await client.query(
      `INSERT INTO knowledge_publication_events(id,target_type,target_id,revision_id,action,actor_id,content_hash)
       VALUES($1,$2,$3,$4,'published',$5,$6)`,
      [eventId, targetType, targetId, revision, actor, contentHash]
    );
    return { published: true, targetType, targetId, revisionId: revision, contentHash, eventId };
  });
}

export async function recordReview(value: unknown, reviewerId: string) {
  const input = requireObject(value);
  const targetType = requireText(input.targetType, "targetType", 40);
  if (!["node", "edge", "source"].includes(targetType)) throw new Error("targetType must be node, edge, or source");
  const revision = requireText(input.revisionId, "revisionId", 250);
  const reviewDimension = requireText(input.reviewDimension, "reviewDimension", 80);
  const state = requireText(input.state, "state", 80);
  if (!["approved", "requires_revision", "rejected", "contested"].includes(state)) throw new Error("unsupported review state");
  const table = targetType === "node" ? "knowledge_node_versions" : targetType === "edge" ? "knowledge_edge_versions" : "knowledge_source_versions";
  const rows = await queryKnowledge(`SELECT content_hash FROM ${table} WHERE revision_id=$1`, [revision]);
  const contentHash = String((rows[0] as Row | undefined)?.content_hash ?? "");
  if (!contentHash) throw new Error("revision not found");
  const id = objectId("review");
  await queryKnowledge(
    `INSERT INTO knowledge_reviews(id,target_type,target_revision_id,review_dimension,state,reviewer_id,notes,content_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, targetType, revision, reviewDimension, state, reviewerId, optionalText(input.notes, "notes", 10_000) ?? null, contentHash]
  );
  return { id, targetType, revisionId: revision, reviewDimension, state, reviewerId, contentHash };
}
