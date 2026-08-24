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
  KnowledgeInputError,
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

export class KnowledgeNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeNotFoundError";
  }
}

export class KnowledgeConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeConflictError";
  }
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nodeFromRow(row: Row, publicView = false): KnowledgeNode {
  const publishedRevisionId = asOptionalString(row.published_revision_id);
  return {
    id: String(row.id),
    kind: row.kind as KnowledgeNode["kind"],
    canonicalSlug: String(row.canonical_slug),
    title: String(row.title),
    ...(row.proposition ? { proposition: String(row.proposition) } : {}),
    ...(row.summary ? { summary: String(row.summary) } : {}),
    ...(row.language ? { language: String(row.language) } : {}),
    contentState: publicView ? "published" : row.content_state as KnowledgeNode["contentState"],
    currentRevisionId: publicView ? publishedRevisionId : asOptionalString(row.current_revision_id),
    publishedRevisionId,
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function nodeFromCurrentSnapshot(row: Row): KnowledgeNode {
  const snapshot = jsonObject(row.current_snapshot);
  return {
    id: String(row.id),
    kind: snapshot.kind as KnowledgeNode["kind"],
    canonicalSlug: String(snapshot.canonicalSlug ?? row.canonical_slug),
    title: String(snapshot.title ?? row.title),
    ...(snapshot.proposition ? { proposition: String(snapshot.proposition) } : {}),
    ...(snapshot.summary ? { summary: String(snapshot.summary) } : {}),
    ...(snapshot.language ? { language: String(snapshot.language) } : {}),
    contentState: (snapshot.contentState ?? row.content_state) as KnowledgeNode["contentState"],
    currentRevisionId: asOptionalString(row.current_revision_id),
    publishedRevisionId: asOptionalString(row.published_revision_id),
    metadata: jsonObject(snapshot.metadata ?? row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function edgeFromRow(row: Row, publicView = false): KnowledgeEdge {
  const publishedRevisionId = asOptionalString(row.published_revision_id);
  return {
    id: String(row.id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    relationshipType: row.relationship_type as KnowledgeEdge["relationshipType"],
    contentState: publicView ? "published" : row.content_state as KnowledgeEdge["contentState"],
    currentRevisionId: publicView ? publishedRevisionId : asOptionalString(row.current_revision_id),
    publishedRevisionId,
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function edgeFromCurrentSnapshot(row: Row): KnowledgeEdge {
  const snapshot = jsonObject(row.current_snapshot);
  return {
    id: String(row.id),
    fromNodeId: String(snapshot.fromNodeId ?? row.from_node_id),
    toNodeId: String(snapshot.toNodeId ?? row.to_node_id),
    relationshipType: (snapshot.relationshipType ?? row.relationship_type) as KnowledgeEdge["relationshipType"],
    contentState: (snapshot.contentState ?? row.content_state) as KnowledgeEdge["contentState"],
    currentRevisionId: asOptionalString(row.current_revision_id),
    publishedRevisionId: asOptionalString(row.published_revision_id),
    metadata: jsonObject(snapshot.metadata ?? row.metadata),
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
    revisionId: String(row.revision_id),
    contentHash: String(row.content_hash),
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
  };
}

function assessmentFromRow(row: Row): KnowledgeAssessment {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    nodeRevisionId: String(row.node_revision_id),
    lens: String(row.lens),
    position: row.position as KnowledgeAssessment["position"],
    rationaleIds: jsonStrings(row.rationale_ids),
    sourceIds: jsonStrings(row.source_ids),
    reviewState: String(row.review_state),
    contentHash: String(row.content_hash),
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function sourceFromRow(row: Row, publicView = false): KnowledgeSource {
  const publishedRevisionId = asOptionalString(row.published_revision_id);
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
    contentState: publicView ? "published" : row.content_state as KnowledgeSource["contentState"],
    currentRevisionId: publicView ? publishedRevisionId : asOptionalString(row.current_revision_id),
    publishedRevisionId,
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function sourceFromCurrentSnapshot(row: Row): KnowledgeSource {
  const snapshot = jsonObject(row.current_snapshot);
  return {
    id: String(row.id),
    sourceType: String(snapshot.sourceType ?? row.source_type),
    title: String(snapshot.title ?? row.title),
    ...(snapshot.author ? { author: String(snapshot.author) } : {}),
    ...(snapshot.edition ? { edition: String(snapshot.edition) } : {}),
    ...(snapshot.language ? { language: String(snapshot.language) } : {}),
    ...(snapshot.authorityClass ? { authorityClass: String(snapshot.authorityClass) } : {}),
    ...(snapshot.bindingStatus ? { bindingStatus: String(snapshot.bindingStatus) } : {}),
    ...(snapshot.licensingStatus ? { licensingStatus: String(snapshot.licensingStatus) } : {}),
    contentState: (snapshot.contentState ?? row.content_state) as KnowledgeSource["contentState"],
    currentRevisionId: asOptionalString(row.current_revision_id),
    publishedRevisionId: asOptionalString(row.published_revision_id),
    metadata: jsonObject(snapshot.metadata ?? row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function citationFromRow(row: Row): KnowledgeCitation {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    ...(row.node_id ? { nodeId: String(row.node_id) } : {}),
    ...(row.node_revision_id ? { nodeRevisionId: String(row.node_revision_id) } : {}),
    ...(row.edge_assertion_id ? { edgeAssertionId: String(row.edge_assertion_id) } : {}),
    locator: String(row.locator),
    ...(row.fragment ? { fragment: String(row.fragment) } : {}),
    fragmentMode: String(row.fragment_mode),
    attributionMode: String(row.attribution_mode),
    reviewState: String(row.review_state),
    contentHash: String(row.content_hash),
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
  };
}

function ensureNotDirectlyPublished(contentState: string): void {
  if (contentState === "published") {
    throw new KnowledgeInputError("published state can only be reached through the governed publication endpoint");
  }
}

async function nextVersion(client: PoolClient, table: string, idColumn: string, id: string): Promise<number> {
  const result = await client.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM ${table} WHERE ${idColumn} = $1`,
    [id]
  );
  return Number(result.rows[0]?.next_version ?? 1);
}

async function requireRevisionBelongsTo(
  targetType: "node" | "edge" | "source",
  targetId: string,
  revision: string
): Promise<{ contentHash: string; snapshot: Record<string, unknown> }> {
  const table = targetType === "node"
    ? "knowledge_node_versions"
    : targetType === "edge" ? "knowledge_edge_versions" : "knowledge_source_versions";
  const idColumn = targetType === "node" ? "node_id" : targetType === "edge" ? "edge_id" : "source_id";
  const rows = await queryKnowledge(
    `SELECT content_hash,snapshot FROM ${table} WHERE ${idColumn}=$1 AND revision_id=$2`,
    [targetId, revision]
  );
  const row = rows[0] as Row | undefined;
  if (!row) throw new KnowledgeNotFoundError(`${targetType} revision not found`);
  return { contentHash: String(row.content_hash), snapshot: jsonObject(row.snapshot) };
}

async function requireSourcesExist(sourceIds: string[]): Promise<void> {
  if (sourceIds.length === 0) return;
  const ids = [...new Set(sourceIds.map((id) => assertCanonicalId(id, "sourceId")))];
  const rows = await queryKnowledge<{ id: string }>(
    `SELECT id FROM knowledge_sources WHERE id=ANY($1::text[])`,
    [ids]
  );
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new KnowledgeInputError(`unknown source id(s): ${missing.join(", ")}`);
  }
}

export async function createNode(value: unknown, actor: string): Promise<KnowledgeNode> {
  const node = validateNodeInput(value);
  ensureNotDirectlyPublished(node.contentState);
  return withKnowledgeTransaction(async (client) => {
    const snapshot = { ...node, aliases: undefined };
    const rev = revisionId("node");
    const hash = stableHash(snapshot);
    await client.query(
      `INSERT INTO knowledge_nodes
       (id,kind,canonical_slug,title,proposition,summary,language,content_state,current_revision_id,published_revision_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10::jsonb)`,
      [node.id, node.kind, node.canonicalSlug, node.title, node.proposition ?? null, node.summary ?? null, node.language ?? null, node.contentState, rev, JSON.stringify(node.metadata)]
    );
    await client.query(
      `INSERT INTO knowledge_node_versions(revision_id,node_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,1,$3,$4::jsonb,$5)`,
      [rev, node.id, hash, JSON.stringify(snapshot), actor]
    );
    for (const alias of [...new Set(node.aliases)]) {
      await client.query(
        `INSERT INTO knowledge_node_aliases(node_id,alias,alias_type,provenance)
         VALUES($1,$2,'search',$3::jsonb) ON CONFLICT DO NOTHING`,
        [node.id, alias, JSON.stringify({ actor, revisionId: rev })]
      );
    }
    const result = await client.query(`SELECT * FROM knowledge_nodes WHERE id=$1`, [node.id]);
    return nodeFromRow(result.rows[0] as Row);
  });
}

export async function reviseNode(idValue: unknown, patchValue: unknown, actor: string): Promise<KnowledgeNode> {
  const id = assertCanonicalId(idValue);
  const patch = requireObject(patchValue);
  return withKnowledgeTransaction(async (client) => {
    const existingResult = await client.query(
      `SELECT n.*,v.snapshot AS current_snapshot
       FROM knowledge_nodes n
       JOIN knowledge_node_versions v ON v.revision_id=n.current_revision_id
       WHERE n.id=$1 FOR UPDATE OF n`,
      [id]
    );
    const existing = existingResult.rows[0] as Row | undefined;
    if (!existing) throw new KnowledgeNotFoundError("Knowledge node not found");
    const current = nodeFromCurrentSnapshot(existing);
    const requestedState = patch.contentState ?? (current.contentState === "published" ? "draft" : current.contentState);
    const merged = validateNodeInput({
      id: current.id,
      kind: patch.kind ?? current.kind,
      canonicalSlug: patch.canonicalSlug ?? current.canonicalSlug,
      title: patch.title ?? current.title,
      proposition: patch.proposition ?? current.proposition,
      summary: patch.summary ?? current.summary,
      language: patch.language ?? current.language,
      contentState: requestedState,
      metadata: patch.metadata ?? current.metadata,
      aliases: patch.aliases ?? [],
    });
    ensureNotDirectlyPublished(merged.contentState);
    const rev = revisionId("node");
    const version = await nextVersion(client, "knowledge_node_versions", "node_id", id);
    const snapshot = { ...merged, aliases: undefined };
    const hash = stableHash(snapshot);
    await client.query(
      `INSERT INTO knowledge_node_versions(revision_id,node_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [rev, id, version, hash, JSON.stringify(snapshot), actor]
    );
    if (existing.published_revision_id) {
      await client.query(
        `UPDATE knowledge_nodes SET current_revision_id=$2,updated_at=NOW() WHERE id=$1`,
        [id, rev]
      );
    } else {
      await client.query(
        `UPDATE knowledge_nodes SET kind=$2,canonical_slug=$3,title=$4,proposition=$5,summary=$6,
         language=$7,content_state=$8,current_revision_id=$9,metadata=$10::jsonb,updated_at=NOW()
         WHERE id=$1`,
        [id, merged.kind, merged.canonicalSlug, merged.title, merged.proposition ?? null, merged.summary ?? null, merged.language ?? null, merged.contentState, rev, JSON.stringify(merged.metadata)]
      );
    }
    for (const alias of [...new Set(merged.aliases)]) {
      await client.query(
        `INSERT INTO knowledge_node_aliases(node_id,alias,alias_type,provenance)
         VALUES($1,$2,'search',$3::jsonb) ON CONFLICT DO NOTHING`,
        [id, alias, JSON.stringify({ actor, revisionId: rev })]
      );
    }
    const result = await client.query(
      `SELECT n.*,v.snapshot AS current_snapshot
       FROM knowledge_nodes n JOIN knowledge_node_versions v ON v.revision_id=n.current_revision_id
       WHERE n.id=$1`,
      [id]
    );
    return nodeFromCurrentSnapshot(result.rows[0] as Row);
  });
}

export async function createEdge(value: unknown, actor: string): Promise<KnowledgeEdge> {
  const edge = validateEdgeInput(value);
  ensureNotDirectlyPublished(edge.contentState);
  return withKnowledgeTransaction(async (client) => {
    const endpoints = await client.query<{ id: string }>(
      `SELECT id FROM knowledge_nodes WHERE id=ANY($1::text[])`,
      [[edge.fromNodeId, edge.toNodeId]]
    );
    if (endpoints.rows.length !== 2) throw new KnowledgeInputError("both edge endpoints must exist");
    const rev = revisionId("edge");
    const hash = stableHash(edge);
    await client.query(
      `INSERT INTO knowledge_edges(id,from_node_id,to_node_id,relationship_type,content_state,current_revision_id,published_revision_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)`,
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

export async function reviseEdge(idValue: unknown, patchValue: unknown, actor: string): Promise<KnowledgeEdge> {
  const id = assertCanonicalId(idValue);
  const patch = requireObject(patchValue);
  return withKnowledgeTransaction(async (client) => {
    const result = await client.query(
      `SELECT e.*,v.snapshot AS current_snapshot
       FROM knowledge_edges e JOIN knowledge_edge_versions v ON v.revision_id=e.current_revision_id
       WHERE e.id=$1 FOR UPDATE OF e`,
      [id]
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) throw new KnowledgeNotFoundError("Knowledge edge not found");
    const current = edgeFromCurrentSnapshot(row);
    if (patch.fromNodeId && patch.fromNodeId !== current.fromNodeId) {
      throw new KnowledgeInputError("edge endpoints are immutable; create a new edge instead");
    }
    if (patch.toNodeId && patch.toNodeId !== current.toNodeId) {
      throw new KnowledgeInputError("edge endpoints are immutable; create a new edge instead");
    }
    if (patch.relationshipType && patch.relationshipType !== current.relationshipType) {
      throw new KnowledgeInputError("relationshipType is immutable; create a new edge instead");
    }
    const requestedState = patch.contentState ?? (current.contentState === "published" ? "draft" : current.contentState);
    const merged = validateEdgeInput({
      id,
      fromNodeId: current.fromNodeId,
      toNodeId: current.toNodeId,
      relationshipType: current.relationshipType,
      contentState: requestedState,
      metadata: patch.metadata ?? current.metadata,
    });
    ensureNotDirectlyPublished(merged.contentState);
    const rev = revisionId("edge");
    const version = await nextVersion(client, "knowledge_edge_versions", "edge_id", id);
    await client.query(
      `INSERT INTO knowledge_edge_versions(revision_id,edge_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [rev, id, version, stableHash(merged), JSON.stringify(merged), actor]
    );
    if (row.published_revision_id) {
      await client.query(`UPDATE knowledge_edges SET current_revision_id=$2,updated_at=NOW() WHERE id=$1`, [id, rev]);
    } else {
      await client.query(
        `UPDATE knowledge_edges SET content_state=$2,current_revision_id=$3,metadata=$4::jsonb,updated_at=NOW() WHERE id=$1`,
        [id, merged.contentState, rev, JSON.stringify(merged.metadata)]
      );
    }
    const updated = await client.query(
      `SELECT e.*,v.snapshot AS current_snapshot FROM knowledge_edges e
       JOIN knowledge_edge_versions v ON v.revision_id=e.current_revision_id WHERE e.id=$1`,
      [id]
    );
    return edgeFromCurrentSnapshot(updated.rows[0] as Row);
  });
}

export async function createEdgeAssertion(value: unknown): Promise<EdgeAssertion> {
  const input = requireObject(value);
  const edgeId = assertCanonicalId(input.edgeId, "edgeId");
  const edgeRevisionId = requireText(input.revisionId, "revisionId", 250);
  await requireRevisionBelongsTo("edge", edgeId, edgeRevisionId);
  const id = input.id ? assertCanonicalId(input.id) : objectId("assertion");
  const assertedByType = requireText(input.assertedByType, "assertedByType", 80);
  const assertedById = requireText(input.assertedById, "assertedById", 200);
  const stance = requireText(input.stance, "stance", 80);
  const attributionMode = requireText(input.attributionMode, "attributionMode", 80);
  const confidence = optionalText(input.confidence, "confidence", 80) ?? "unresolved";
  const sourceIds = asStringArray(input.sourceIds, "sourceIds", 50).map((sourceId) => assertCanonicalId(sourceId, "sourceId"));
  await requireSourcesExist(sourceIds);
  const metadata = asMetadata(input.metadata);
  const normalized = { id, edgeId, revisionId: edgeRevisionId, assertedByType, assertedById, stance, sourceIds, attributionMode, confidence, metadata };
  const contentHash = stableHash(normalized);
  const rows = await queryKnowledge(
    `INSERT INTO knowledge_edge_assertions
     (id,edge_id,asserted_by_type,asserted_by_id,stance,source_ids,attribution_mode,confidence,review_state,revision_id,content_hash,metadata)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'awaiting_review',$9,$10,$11::jsonb)
     RETURNING *`,
    [id, edgeId, assertedByType, assertedById, stance, JSON.stringify(sourceIds), attributionMode, confidence, edgeRevisionId, contentHash, JSON.stringify(metadata)]
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
  ensureNotDirectlyPublished(snapshot.contentState);
  return withKnowledgeTransaction(async (client) => {
    const rev = revisionId("source");
    await client.query(
      `INSERT INTO knowledge_sources
       (id,source_type,title,author,edition,language,authority_class,binding_status,licensing_status,content_state,current_revision_id,published_revision_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12::jsonb)`,
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

export async function reviseSource(idValue: unknown, patchValue: unknown, actor: string): Promise<KnowledgeSource> {
  const id = assertCanonicalId(idValue);
  const patch = requireObject(patchValue);
  return withKnowledgeTransaction(async (client) => {
    const result = await client.query(
      `SELECT s.*,v.snapshot AS current_snapshot FROM knowledge_sources s
       JOIN knowledge_source_versions v ON v.revision_id=s.current_revision_id
       WHERE s.id=$1 FOR UPDATE OF s`,
      [id]
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) throw new KnowledgeNotFoundError("Knowledge source not found");
    const current = sourceFromCurrentSnapshot(row);
    const requestedState = patch.contentState ?? (current.contentState === "published" ? "draft" : current.contentState);
    const snapshot = {
      id,
      sourceType: optionalText(patch.sourceType, "sourceType", 80) ?? current.sourceType,
      title: optionalText(patch.title, "title", 500) ?? current.title,
      author: patch.author === null ? undefined : optionalText(patch.author, "author", 300) ?? current.author,
      edition: patch.edition === null ? undefined : optionalText(patch.edition, "edition", 500) ?? current.edition,
      language: patch.language === null ? undefined : optionalText(patch.language, "language", 40) ?? current.language,
      authorityClass: patch.authorityClass === null ? undefined : optionalText(patch.authorityClass, "authorityClass", 100) ?? current.authorityClass,
      bindingStatus: patch.bindingStatus === null ? undefined : optionalText(patch.bindingStatus, "bindingStatus", 100) ?? current.bindingStatus,
      licensingStatus: optionalText(patch.licensingStatus, "licensingStatus", 100) ?? current.licensingStatus ?? "unknown",
      contentState: parseContentState(requestedState),
      metadata: patch.metadata === undefined ? current.metadata : asMetadata(patch.metadata),
    };
    ensureNotDirectlyPublished(snapshot.contentState);
    const rev = revisionId("source");
    const version = await nextVersion(client, "knowledge_source_versions", "source_id", id);
    await client.query(
      `INSERT INTO knowledge_source_versions(revision_id,source_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [rev, id, version, stableHash(snapshot), JSON.stringify(snapshot), actor]
    );
    if (row.published_revision_id) {
      await client.query(`UPDATE knowledge_sources SET current_revision_id=$2,updated_at=NOW() WHERE id=$1`, [id, rev]);
    } else {
      await client.query(
        `UPDATE knowledge_sources SET source_type=$2,title=$3,author=$4,edition=$5,language=$6,authority_class=$7,
         binding_status=$8,licensing_status=$9,content_state=$10,current_revision_id=$11,metadata=$12::jsonb,updated_at=NOW()
         WHERE id=$1`,
        [id, snapshot.sourceType, snapshot.title, snapshot.author ?? null, snapshot.edition ?? null, snapshot.language ?? null, snapshot.authorityClass ?? null, snapshot.bindingStatus ?? null, snapshot.licensingStatus, snapshot.contentState, rev, JSON.stringify(snapshot.metadata)]
      );
    }
    const updated = await client.query(
      `SELECT s.*,v.snapshot AS current_snapshot FROM knowledge_sources s
       JOIN knowledge_source_versions v ON v.revision_id=s.current_revision_id WHERE s.id=$1`,
      [id]
    );
    return sourceFromCurrentSnapshot(updated.rows[0] as Row);
  });
}

export async function createCitation(value: unknown): Promise<KnowledgeCitation> {
  const input = requireObject(value);
  const id = input.id ? assertCanonicalId(input.id) : objectId("citation");
  const sourceId = assertCanonicalId(input.sourceId, "sourceId");
  await requireSourcesExist([sourceId]);
  const nodeId = input.nodeId ? assertCanonicalId(input.nodeId, "nodeId") : undefined;
  const nodeRevisionId = input.nodeRevisionId ? requireText(input.nodeRevisionId, "nodeRevisionId", 250) : undefined;
  const edgeAssertionId = input.edgeAssertionId ? assertCanonicalId(input.edgeAssertionId, "edgeAssertionId") : undefined;
  if (!nodeId && !edgeAssertionId) throw new KnowledgeInputError("citation requires nodeId or edgeAssertionId");
  if (nodeId && !nodeRevisionId) throw new KnowledgeInputError("nodeRevisionId is required when citation targets a node");
  if (nodeId && nodeRevisionId) await requireRevisionBelongsTo("node", nodeId, nodeRevisionId);
  if (edgeAssertionId) {
    const assertionRows = await queryKnowledge(`SELECT id FROM knowledge_edge_assertions WHERE id=$1`, [edgeAssertionId]);
    if (!assertionRows[0]) throw new KnowledgeNotFoundError("edge assertion not found");
  }
  const locator = requireText(input.locator, "locator", 1000);
  const fragment = optionalText(input.fragment, "fragment", 20_000);
  const fragmentMode = optionalText(input.fragmentMode, "fragmentMode", 80) ?? "reference_only";
  const attributionMode = optionalText(input.attributionMode, "attributionMode", 80) ?? "source";
  const metadata = asMetadata(input.metadata);
  const normalized = { id, sourceId, nodeId, nodeRevisionId, edgeAssertionId, locator, fragment, fragmentMode, attributionMode, metadata };
  const contentHash = stableHash(normalized);
  const rows = await queryKnowledge(
    `INSERT INTO knowledge_citations
     (id,source_id,node_id,node_revision_id,edge_assertion_id,locator,fragment,fragment_mode,attribution_mode,content_hash,review_state,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unverified',$11::jsonb) RETURNING *`,
    [id, sourceId, nodeId ?? null, nodeRevisionId ?? null, edgeAssertionId ?? null, locator, fragment ?? null, fragmentMode, attributionMode, contentHash, JSON.stringify(metadata)]
  );
  return citationFromRow(rows[0] as Row);
}

export async function upsertAssessment(value: unknown): Promise<KnowledgeAssessment> {
  const input = requireObject(value);
  const nodeId = assertCanonicalId(input.nodeId, "nodeId");
  const nodeRevisionId = requireText(input.nodeRevisionId, "nodeRevisionId", 250);
  await requireRevisionBelongsTo("node", nodeId, nodeRevisionId);
  const lens = requireText(input.lens, "lens", 120).toLowerCase();
  const position = parseAssessmentPosition(input.position);
  const rationaleIds = asStringArray(input.rationaleIds, "rationaleIds", 50).map((id) => assertCanonicalId(id, "rationaleId"));
  const sourceIds = asStringArray(input.sourceIds, "sourceIds", 50).map((id) => assertCanonicalId(id, "sourceId"));
  await requireSourcesExist(sourceIds);
  const metadata = asMetadata(input.metadata);
  const id = input.id ? assertCanonicalId(input.id) : `assessment:${stableHash({ nodeRevisionId, lens }).slice(0, 24)}`;
  const normalized = { id, nodeId, nodeRevisionId, lens, position, rationaleIds, sourceIds, metadata };
  const contentHash = stableHash(normalized);
  const rows = await queryKnowledge(
    `INSERT INTO knowledge_assessments(id,node_id,node_revision_id,lens,position,rationale_ids,source_ids,review_state,content_hash,metadata)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'awaiting_review',$8,$9::jsonb)
     ON CONFLICT(node_id,node_revision_id,lens) DO UPDATE SET position=EXCLUDED.position,rationale_ids=EXCLUDED.rationale_ids,
       source_ids=EXCLUDED.source_ids,review_state='awaiting_review',content_hash=EXCLUDED.content_hash,metadata=EXCLUDED.metadata,updated_at=NOW()
     RETURNING *`,
    [id, nodeId, nodeRevisionId, lens, position, JSON.stringify(rationaleIds), JSON.stringify(sourceIds), contentHash, JSON.stringify(metadata)]
  );
  return assessmentFromRow(rows[0] as Row);
}

export async function addClaimFamilyMember(value: unknown, actor: string): Promise<void> {
  const input = requireObject(value);
  const familyNodeId = assertCanonicalId(input.familyNodeId, "familyNodeId");
  const claimNodeId = assertCanonicalId(input.claimNodeId, "claimNodeId");
  const relation = optionalText(input.relation, "relation", 80) ?? "member";
  const rows = await queryKnowledge<{ id: string; kind: string }>(
    `SELECT id,kind FROM knowledge_nodes WHERE id=ANY($1::text[])`,
    [[familyNodeId, claimNodeId]]
  );
  const family = rows.find((row) => row.id === familyNodeId);
  const claim = rows.find((row) => row.id === claimNodeId);
  if (!family || family.kind !== "claim_family") throw new KnowledgeInputError("familyNodeId must identify a claim_family node");
  if (!claim || !["claim", "objection", "response", "conclusion"].includes(claim.kind)) {
    throw new KnowledgeInputError("claimNodeId must identify a claim-like node");
  }
  await queryKnowledge(
    `INSERT INTO knowledge_claim_family_members(family_node_id,claim_node_id,relation,created_by)
     VALUES($1,$2,$3,$4) ON CONFLICT(family_node_id,claim_node_id) DO UPDATE SET relation=EXCLUDED.relation`,
    [familyNodeId, claimNodeId, relation, actor]
  );
}

export async function getNode(idValue: unknown, includeUnpublished = false): Promise<KnowledgeNode | null> {
  const id = assertCanonicalId(idValue);
  if (includeUnpublished) {
    const rows = await queryKnowledge(
      `SELECT n.*,v.snapshot AS current_snapshot FROM knowledge_nodes n
       JOIN knowledge_node_versions v ON v.revision_id=n.current_revision_id WHERE n.id=$1`,
      [id]
    );
    return rows[0] ? nodeFromCurrentSnapshot(rows[0] as Row) : null;
  }
  const rows = await queryKnowledge(`SELECT * FROM knowledge_nodes WHERE id=$1 AND published_revision_id IS NOT NULL`, [id]);
  return rows[0] ? nodeFromRow(rows[0] as Row, true) : null;
}

export async function getSource(idValue: unknown, includeUnpublished = false): Promise<KnowledgeSource | null> {
  const id = assertCanonicalId(idValue);
  if (includeUnpublished) {
    const rows = await queryKnowledge(
      `SELECT s.*,v.snapshot AS current_snapshot FROM knowledge_sources s
       JOIN knowledge_source_versions v ON v.revision_id=s.current_revision_id WHERE s.id=$1`,
      [id]
    );
    return rows[0] ? sourceFromCurrentSnapshot(rows[0] as Row) : null;
  }
  const rows = await queryKnowledge(`SELECT * FROM knowledge_sources WHERE id=$1 AND published_revision_id IS NOT NULL`, [id]);
  return rows[0] ? sourceFromRow(rows[0] as Row, true) : null;
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
  const publishedEdgeClause = options.includeUnpublished ? "" : "AND e.published_revision_id IS NOT NULL";
  const root = await getNode(rootNodeId, options.includeUnpublished);
  if (!root) return null;

  const walkRows = await queryKnowledge<{ node_id: string; depth: number }>(
    `WITH RECURSIVE walk(node_id,depth,path) AS (
       SELECT $1::text,0,ARRAY[$1::text]
       UNION ALL
       SELECT CASE WHEN e.from_node_id=w.node_id THEN e.to_node_id ELSE e.from_node_id END,
              w.depth+1,
              w.path || CASE WHEN e.from_node_id=w.node_id THEN e.to_node_id ELSE e.from_node_id END
       FROM walk w
       JOIN knowledge_edges e ON (e.from_node_id=w.node_id OR e.to_node_id=w.node_id)
       WHERE w.depth<$2 ${publishedEdgeClause}
         AND NOT (CASE WHEN e.from_node_id=w.node_id THEN e.to_node_id ELSE e.from_node_id END = ANY(w.path))
     )
     SELECT node_id,MIN(depth)::int AS depth FROM walk GROUP BY node_id ORDER BY MIN(depth),node_id LIMIT $3`,
    [rootNodeId, depth, limit]
  );
  const nodeIds = walkRows.map((row) => row.node_id);
  const nodeRows = options.includeUnpublished
    ? await queryKnowledge(
        `SELECT n.*,v.snapshot AS current_snapshot FROM knowledge_nodes n
         JOIN knowledge_node_versions v ON v.revision_id=n.current_revision_id
         WHERE n.id=ANY($1::text[]) ORDER BY n.id`,
        [nodeIds]
      )
    : await queryKnowledge(
        `SELECT * FROM knowledge_nodes WHERE id=ANY($1::text[]) AND published_revision_id IS NOT NULL ORDER BY id`,
        [nodeIds]
      );
  const edgeRows = options.includeUnpublished
    ? await queryKnowledge(
        `SELECT e.*,v.snapshot AS current_snapshot FROM knowledge_edges e
         JOIN knowledge_edge_versions v ON v.revision_id=e.current_revision_id
         WHERE e.from_node_id=ANY($1::text[]) AND e.to_node_id=ANY($1::text[])
         ORDER BY e.id LIMIT $2`,
        [nodeIds, limit * 3]
      )
    : await queryKnowledge(
        `SELECT * FROM knowledge_edges
         WHERE from_node_id=ANY($1::text[]) AND to_node_id=ANY($1::text[]) AND published_revision_id IS NOT NULL
         ORDER BY id LIMIT $2`,
        [nodeIds, limit * 3]
      );
  const edgeIds = edgeRows.map((row) => String((row as Row).id));
  const assertionRows = edgeIds.length === 0 ? [] : options.includeUnpublished
    ? await queryKnowledge(`SELECT * FROM knowledge_edge_assertions WHERE edge_id=ANY($1::text[]) ORDER BY created_at`, [edgeIds])
    : await queryKnowledge(
        `SELECT a.* FROM knowledge_edge_assertions a
         JOIN knowledge_edges e ON e.id=a.edge_id
         WHERE a.edge_id=ANY($1::text[]) AND a.review_state='approved' AND a.revision_id=e.published_revision_id
         ORDER BY a.created_at`,
        [edgeIds]
      );
  const lens = options.lens?.trim().toLowerCase();
  const assessmentRows = nodeIds.length === 0 ? [] : options.includeUnpublished
    ? await queryKnowledge(
        `SELECT * FROM knowledge_assessments WHERE node_id=ANY($1::text[]) ${lens ? "AND lens=$2" : ""} ORDER BY node_id,lens`,
        lens ? [nodeIds, lens] : [nodeIds]
      )
    : await queryKnowledge(
        `SELECT a.* FROM knowledge_assessments a JOIN knowledge_nodes n ON n.id=a.node_id
         WHERE a.node_id=ANY($1::text[]) AND a.review_state='approved' AND a.node_revision_id=n.published_revision_id
         ${lens ? "AND a.lens=$2" : ""} ORDER BY a.node_id,a.lens`,
        lens ? [nodeIds, lens] : [nodeIds]
      );
  return {
    rootNodeId,
    depth,
    nodes: nodeRows.map((row) => options.includeUnpublished ? nodeFromCurrentSnapshot(row as Row) : nodeFromRow(row as Row, true)),
    edges: edgeRows.map((row) => options.includeUnpublished ? edgeFromCurrentSnapshot(row as Row) : edgeFromRow(row as Row, true)),
    assertions: assertionRows.map((row) => assertionFromRow(row as Row)),
    assessments: assessmentRows.map((row) => assessmentFromRow(row as Row)),
  };
}

export async function getNodeEvidence(idValue: unknown, includeUnpublished = false) {
  const node = await getNode(idValue, includeUnpublished);
  if (!node) return null;
  const revision = includeUnpublished ? node.currentRevisionId : node.publishedRevisionId;
  const citations = await queryKnowledge(
    `SELECT c.* FROM knowledge_citations c
     WHERE c.node_id=$1 AND c.node_revision_id=$2 ${includeUnpublished ? "" : "AND c.review_state='approved'"}
     ORDER BY c.created_at`,
    [node.id, revision]
  );
  const sourceIds = [...new Set(citations.map((row) => String((row as Row).source_id)))];
  const sources = sourceIds.length === 0 ? [] : includeUnpublished
    ? await queryKnowledge(
        `SELECT s.*,v.snapshot AS current_snapshot FROM knowledge_sources s
         JOIN knowledge_source_versions v ON v.revision_id=s.current_revision_id WHERE s.id=ANY($1::text[]) ORDER BY s.title`,
        [sourceIds]
      )
    : await queryKnowledge(
        `SELECT * FROM knowledge_sources WHERE id=ANY($1::text[]) AND published_revision_id IS NOT NULL ORDER BY title`,
        [sourceIds]
      );
  return {
    node,
    citations: citations.map((row) => citationFromRow(row as Row)),
    sources: sources.map((row) => includeUnpublished ? sourceFromCurrentSnapshot(row as Row) : sourceFromRow(row as Row, true)),
  };
}

export async function getNodeAssessments(idValue: unknown, lensValue?: unknown, includeUnpublished = false) {
  const node = await getNode(idValue, includeUnpublished);
  if (!node) return [];
  const revision = includeUnpublished ? node.currentRevisionId : node.publishedRevisionId;
  const lens = typeof lensValue === "string" && lensValue.trim() ? lensValue.trim().toLowerCase() : null;
  const rows = await queryKnowledge(
    `SELECT * FROM knowledge_assessments WHERE node_id=$1 AND node_revision_id=$2
     ${includeUnpublished ? "" : "AND review_state='approved'"} ${lens ? "AND lens=$3" : ""} ORDER BY lens`,
    lens ? [node.id, revision, lens] : [node.id, revision]
  );
  return rows.map((row) => assessmentFromRow(row as Row));
}

export async function searchKnowledge(
  queryValue: unknown,
  options: { kind?: string; includeUnpublished?: boolean; limit?: number } = {}
) {
  const query = requireText(queryValue, "q", 500);
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  const pattern = `%${query.toLowerCase()}%`;
  if (options.includeUnpublished) {
    const params: unknown[] = [pattern];
    let kindClause = "";
    if (options.kind) {
      params.push(options.kind);
      kindClause = `AND (v.snapshot->>'kind')=$${params.length}`;
    }
    params.push(limit);
    const rows = await queryKnowledge(
      `SELECT n.*,v.snapshot AS current_snapshot
       FROM knowledge_nodes n JOIN knowledge_node_versions v ON v.revision_id=n.current_revision_id
       WHERE (LOWER(v.snapshot->>'title') LIKE $1 OR LOWER(COALESCE(v.snapshot->>'proposition','')) LIKE $1)
       ${kindClause} ORDER BY LOWER(v.snapshot->>'title') LIMIT $${params.length}`,
      params
    );
    return rows.map((row) => nodeFromCurrentSnapshot(row as Row));
  }
  const params: unknown[] = [pattern, query.toLowerCase()];
  let kindClause = "";
  if (options.kind) {
    params.push(options.kind);
    kindClause = `AND kind=$${params.length}`;
  }
  params.push(limit);
  const rows = await queryKnowledge(
    `SELECT *,CASE WHEN LOWER(title)=$2 THEN 0 WHEN LOWER(title) LIKE $1 THEN 1 ELSE 2 END AS rank_hint
     FROM knowledge_nodes
     WHERE published_revision_id IS NOT NULL
       AND (LOWER(title) LIKE $1 OR LOWER(COALESCE(proposition,'')) LIKE $1)
       ${kindClause}
     ORDER BY rank_hint,title LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => nodeFromRow(row as Row, true));
}

export async function reconciliationSuggestions(queryValue: unknown, kindValue?: unknown, limitValue?: unknown) {
  const query = requireText(queryValue, "q", 500);
  const kind = typeof kindValue === "string" && kindValue.trim() ? kindValue.trim() : undefined;
  const limit = Math.max(1, Math.min(30, Number.parseInt(String(limitValue ?? "12"), 10) || 12));
  const tokens = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3))].slice(0, 12);
  const rows = await queryKnowledge(
    `SELECT n.*,v.snapshot AS current_snapshot,
      (CASE WHEN LOWER(v.snapshot->>'title')=LOWER($1) THEN 100 ELSE 0 END
       + CASE WHEN LOWER(v.snapshot->>'title') LIKE '%' || LOWER($1) || '%' THEN 35 ELSE 0 END
       + CASE WHEN LOWER(COALESCE(v.snapshot->>'proposition','')) LIKE '%' || LOWER($1) || '%' THEN 25 ELSE 0 END
       + (SELECT COUNT(*)::int*5 FROM unnest($2::text[]) t
          WHERE LOWER(COALESCE(v.snapshot->>'title','') || ' ' || COALESCE(v.snapshot->>'proposition','')) LIKE '%' || t || '%')
      ) AS lexical_score
     FROM knowledge_nodes n JOIN knowledge_node_versions v ON v.revision_id=n.current_revision_id
     WHERE ($3::text IS NULL OR (v.snapshot->>'kind')=$3)
     ORDER BY lexical_score DESC,n.updated_at DESC LIMIT $4`,
    [query, tokens, kind ?? null, limit]
  );
  return rows
    .map((row) => ({ node: nodeFromCurrentSnapshot(row as Row), score: Number((row as Row).lexical_score ?? 0) }))
    .filter((entry) => entry.score > 0);
}

export async function compareNodes(leftValue: unknown, rightValue: unknown) {
  const left = assertCanonicalId(leftValue, "left");
  const right = assertCanonicalId(rightValue, "right");
  if (left === right) throw new KnowledgeInputError("left and right must identify different nodes");
  const nodes = await queryKnowledge(
    `SELECT * FROM knowledge_nodes WHERE id=ANY($1::text[]) AND published_revision_id IS NOT NULL`,
    [[left, right]]
  );
  if (nodes.length !== 2) return null;
  const directEdges = await queryKnowledge(
    `SELECT * FROM knowledge_edges WHERE published_revision_id IS NOT NULL
     AND ((from_node_id=$1 AND to_node_id=$2) OR (from_node_id=$2 AND to_node_id=$1))`,
    [left, right]
  );
  const shared = await queryKnowledge(
    `WITH left_neighbors AS (
       SELECT CASE WHEN from_node_id=$1 THEN to_node_id ELSE from_node_id END AS node_id
       FROM knowledge_edges WHERE published_revision_id IS NOT NULL AND (from_node_id=$1 OR to_node_id=$1)
     ),right_neighbors AS (
       SELECT CASE WHEN from_node_id=$2 THEN to_node_id ELSE from_node_id END AS node_id
       FROM knowledge_edges WHERE published_revision_id IS NOT NULL AND (from_node_id=$2 OR to_node_id=$2)
     )
     SELECT DISTINCT n.* FROM knowledge_nodes n
     JOIN left_neighbors l ON l.node_id=n.id JOIN right_neighbors r ON r.node_id=n.id
     WHERE n.published_revision_id IS NOT NULL ORDER BY n.title LIMIT 50`,
    [left, right]
  );
  return {
    left: nodeFromRow(nodes.find((row) => String((row as Row).id) === left) as Row, true),
    right: nodeFromRow(nodes.find((row) => String((row as Row).id) === right) as Row, true),
    directEdges: directEdges.map((row) => edgeFromRow(row as Row, true)),
    sharedNeighbors: shared.map((row) => nodeFromRow(row as Row, true)),
  };
}

const REVIEW_DIMENSIONS = new Set(["source", "doctrinal", "translation", "historical", "licensing", "provenance"]);
const REVIEW_STATES = new Set(["approved", "requires_revision", "rejected", "contested"]);

async function resolveReviewTarget(input: Record<string, unknown>): Promise<{
  targetType: string;
  targetRevisionId: string;
  contentHash: string;
  updateArtifact?: { table: string; id: string };
}> {
  const targetType = requireText(input.targetType, "targetType", 40);
  if (["node", "edge", "source"].includes(targetType)) {
    const revision = requireText(input.revisionId, "revisionId", 250);
    const table = targetType === "node"
      ? "knowledge_node_versions"
      : targetType === "edge" ? "knowledge_edge_versions" : "knowledge_source_versions";
    const rows = await queryKnowledge(`SELECT content_hash FROM ${table} WHERE revision_id=$1`, [revision]);
    const contentHash = String((rows[0] as Row | undefined)?.content_hash ?? "");
    if (!contentHash) throw new KnowledgeNotFoundError("revision not found");
    return { targetType, targetRevisionId: revision, contentHash };
  }
  const targetId = assertCanonicalId(input.targetId, "targetId");
  const artifact = targetType === "edge_assertion"
    ? { table: "knowledge_edge_assertions" }
    : targetType === "citation"
      ? { table: "knowledge_citations" }
      : targetType === "assessment"
        ? { table: "knowledge_assessments" }
        : null;
  if (!artifact) throw new KnowledgeInputError("unsupported review targetType");
  const rows = await queryKnowledge(`SELECT content_hash FROM ${artifact.table} WHERE id=$1`, [targetId]);
  const contentHash = String((rows[0] as Row | undefined)?.content_hash ?? "");
  if (!contentHash) throw new KnowledgeNotFoundError(`${targetType} not found`);
  return { targetType, targetRevisionId: targetId, contentHash, updateArtifact: { table: artifact.table, id: targetId } };
}

export async function recordReview(value: unknown, reviewerId: string) {
  const input = requireObject(value);
  const reviewDimension = requireText(input.reviewDimension, "reviewDimension", 80);
  const state = requireText(input.state, "state", 80);
  if (!REVIEW_DIMENSIONS.has(reviewDimension)) throw new KnowledgeInputError("unsupported review dimension");
  if (!REVIEW_STATES.has(state)) throw new KnowledgeInputError("unsupported review state");
  const target = await resolveReviewTarget(input);
  const id = objectId("review");
  return withKnowledgeTransaction(async (client) => {
    await client.query(
      `INSERT INTO knowledge_reviews(id,target_type,target_revision_id,review_dimension,state,reviewer_id,notes,content_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, target.targetType, target.targetRevisionId, reviewDimension, state, reviewerId, optionalText(input.notes, "notes", 10_000) ?? null, target.contentHash]
    );
    if (target.updateArtifact) {
      await client.query(`UPDATE ${target.updateArtifact.table} SET review_state=$2 WHERE id=$1`, [target.updateArtifact.id, state]);
    }
    return {
      id,
      targetType: target.targetType,
      targetRevisionId: target.targetRevisionId,
      reviewDimension,
      state,
      reviewerId,
      contentHash: target.contentHash,
    };
  });
}

export async function publishRevision(value: unknown, actor: string) {
  const input = requireObject(value);
  const targetType = requireText(input.targetType, "targetType", 40);
  if (!["node", "edge", "source"].includes(targetType)) throw new KnowledgeInputError("targetType must be node, edge, or source");
  const targetId = assertCanonicalId(input.targetId, "targetId");
  const revision = requireText(input.revisionId, "revisionId", 250);
  const revisionData = await requireRevisionBelongsTo(targetType as "node" | "edge" | "source", targetId, revision);
  return withKnowledgeTransaction(async (client) => {
    const targetTable = targetType === "node" ? "knowledge_nodes" : targetType === "edge" ? "knowledge_edges" : "knowledge_sources";
    const current = await client.query(`SELECT current_revision_id FROM ${targetTable} WHERE id=$1 FOR UPDATE`, [targetId]);
    if (!current.rows[0]) throw new KnowledgeNotFoundError(`${targetType} not found`);
    if (current.rows[0].current_revision_id !== revision) throw new KnowledgeConflictError("only the current revision can be published");

    const reviews = await client.query(
      `SELECT review_dimension,state,content_hash FROM knowledge_reviews
       WHERE target_type=$1 AND target_revision_id=$2`,
      [targetType, revision]
    );
    const requiredDimensions = targetType === "source" ? ["source"] : ["source", "doctrinal"];
    for (const dimension of requiredDimensions) {
      const approved = reviews.rows.some((row) => row.review_dimension === dimension && row.state === "approved" && row.content_hash === revisionData.contentHash);
      if (!approved) throw new KnowledgeConflictError(`publication requires approved ${dimension} review bound to this revision hash`);
    }
    if (targetType === "edge") {
      const assertion = await client.query(
        `SELECT id FROM knowledge_edge_assertions
         WHERE edge_id=$1 AND revision_id=$2 AND review_state='approved' LIMIT 1`,
        [targetId, revision]
      );
      if (!assertion.rows[0]) throw new KnowledgeConflictError("a published edge requires at least one approved attributable assertion for this revision");
    }

    const snapshot = revisionData.snapshot;
    if (targetType === "node") {
      const node = validateNodeInput({ ...snapshot, contentState: "approved", aliases: [] });
      await client.query(
        `UPDATE knowledge_nodes SET kind=$2,canonical_slug=$3,title=$4,proposition=$5,summary=$6,language=$7,
         content_state='published',published_revision_id=$8,metadata=$9::jsonb,updated_at=NOW()
         WHERE id=$1 AND current_revision_id=$8`,
        [targetId, node.kind, node.canonicalSlug, node.title, node.proposition ?? null, node.summary ?? null, node.language ?? null, revision, JSON.stringify(node.metadata)]
      );
    } else if (targetType === "edge") {
      const edge = validateEdgeInput({ ...snapshot, contentState: "approved" });
      await client.query(
        `UPDATE knowledge_edges SET content_state='published',published_revision_id=$2,metadata=$3::jsonb,updated_at=NOW()
         WHERE id=$1 AND current_revision_id=$2`,
        [targetId, revision, JSON.stringify(edge.metadata)]
      );
    } else {
      const source = snapshot;
      await client.query(
        `UPDATE knowledge_sources SET source_type=$2,title=$3,author=$4,edition=$5,language=$6,authority_class=$7,
         binding_status=$8,licensing_status=$9,content_state='published',published_revision_id=$10,metadata=$11::jsonb,updated_at=NOW()
         WHERE id=$1 AND current_revision_id=$10`,
        [
          targetId,
          requireText(source.sourceType, "sourceType", 80),
          requireText(source.title, "title", 500),
          optionalText(source.author, "author", 300) ?? null,
          optionalText(source.edition, "edition", 500) ?? null,
          optionalText(source.language, "language", 40) ?? null,
          optionalText(source.authorityClass, "authorityClass", 100) ?? null,
          optionalText(source.bindingStatus, "bindingStatus", 100) ?? null,
          optionalText(source.licensingStatus, "licensingStatus", 100) ?? "unknown",
          revision,
          JSON.stringify(asMetadata(source.metadata)),
        ]
      );
    }
    const eventId = objectId("publication");
    await client.query(
      `INSERT INTO knowledge_publication_events(id,target_type,target_id,revision_id,action,actor_id,content_hash)
       VALUES($1,$2,$3,$4,'published',$5,$6)`,
      [eventId, targetType, targetId, revision, actor, revisionData.contentHash]
    );
    return { published: true, targetType, targetId, revisionId: revision, contentHash: revisionData.contentHash, eventId };
  });
}
