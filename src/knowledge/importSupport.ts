import { queryKnowledge } from "./db";
import type { KnowledgeEdge } from "./types";
import { assertCanonicalId } from "./validation";

type Row = Record<string, unknown>;
const MAX_EXISTENCE_BATCH = 1000;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function validateCanonicalIdBatch(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  if (values.length > MAX_EXISTENCE_BATCH) {
    throw new Error(`ids exceeds ${MAX_EXISTENCE_BATCH} entries`);
  }
  return [...new Set(values.map((value) => assertCanonicalId(value, "id")))];
}

export async function getEdgeForAuthoring(idValue: unknown): Promise<KnowledgeEdge | null> {
  const id = assertCanonicalId(idValue);
  const rows = await queryKnowledge(
    `SELECT e.*,v.snapshot AS current_snapshot
     FROM knowledge_edges e
     JOIN knowledge_edge_versions v ON v.revision_id=e.current_revision_id
     WHERE e.id=$1`,
    [id]
  );
  const row = rows[0] as Row | undefined;
  if (!row) return null;
  const snapshot = jsonObject(row.current_snapshot);
  return {
    id: String(row.id),
    fromNodeId: String(snapshot.fromNodeId ?? row.from_node_id),
    toNodeId: String(snapshot.toNodeId ?? row.to_node_id),
    relationshipType: (snapshot.relationshipType ?? row.relationship_type) as KnowledgeEdge["relationshipType"],
    contentState: (snapshot.contentState ?? row.content_state) as KnowledgeEdge["contentState"],
    currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null,
    publishedRevisionId: row.published_revision_id ? String(row.published_revision_id) : null,
    metadata: jsonObject(snapshot.metadata ?? row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function getExistingCanonicalIds(values: unknown): Promise<Set<string>> {
  const ids = validateCanonicalIdBatch(values);
  if (ids.length === 0) return new Set();
  const [nodeRows, edgeRows, sourceRows] = await Promise.all([
    queryKnowledge<{ id: string }>(`SELECT id FROM knowledge_nodes WHERE id=ANY($1::text[])`, [ids]),
    queryKnowledge<{ id: string }>(`SELECT id FROM knowledge_edges WHERE id=ANY($1::text[])`, [ids]),
    queryKnowledge<{ id: string }>(`SELECT id FROM knowledge_sources WHERE id=ANY($1::text[])`, [ids]),
  ]);
  return new Set([...nodeRows, ...edgeRows, ...sourceRows].map((row) => row.id));
}
