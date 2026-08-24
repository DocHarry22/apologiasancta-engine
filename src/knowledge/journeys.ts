import type { PoolClient } from "pg";
import { queryKnowledge, withKnowledgeTransaction } from "./db";
import { KnowledgeConflictError, KnowledgeNotFoundError } from "./repository";
import {
  asMetadata,
  assertCanonicalId,
  KnowledgeInputError,
  objectId,
  optionalText,
  parseContentState,
  requireObject,
  requireText,
  revisionId,
  stableHash,
} from "./validation";

export type JourneyTargetType = "topic" | "path" | "argument";
type Row = Record<string, unknown>;
type JourneyConfig = { table: string; versionTable: string; idColumn: string; requiredReviews: string[] };

export interface TopicSnapshot {
  id: string; title: string; rootNodeId: string; summary?: string; featuredNodeIds: string[];
  contentState: ReturnType<typeof parseContentState>; metadata: Record<string, unknown>;
}
export interface PathStep { nodeId: string; role: string; metadata: Record<string, unknown> }
export interface PathSnapshot {
  id: string; topicId?: string; title: string; pathType: string; description?: string; steps: PathStep[];
  contentState: ReturnType<typeof parseContentState>; metadata: Record<string, unknown>;
}
export interface ArgumentMember { nodeId: string; role: string; position: number; metadata: Record<string, unknown> }
export interface ArgumentSnapshot {
  id: string; title: string; argumentType: string; conclusionNodeId: string; members: ArgumentMember[];
  contentState: ReturnType<typeof parseContentState>; metadata: Record<string, unknown>;
}
type JourneySnapshotMap = { topic: TopicSnapshot; path: PathSnapshot; argument: ArgumentSnapshot };
export type StoredJourney<T extends JourneyTargetType> = JourneySnapshotMap[T] & {
  currentRevisionId: string; publishedRevisionId: string | null;
};

const CONFIG: Record<JourneyTargetType, JourneyConfig> = {
  topic: { table: "knowledge_topics", versionTable: "knowledge_topic_versions", idColumn: "topic_id", requiredReviews: ["doctrinal", "editorial"] },
  path: { table: "knowledge_paths", versionTable: "knowledge_path_versions", idColumn: "path_id", requiredReviews: ["doctrinal", "editorial"] },
  argument: { table: "knowledge_arguments", versionTable: "knowledge_argument_versions", idColumn: "argument_id", requiredReviews: ["source", "doctrinal"] },
};
const ARGUMENT_TYPES = new Set(["deductive", "inductive", "abductive", "historical", "textual", "linguistic", "philosophical", "typological", "patristic", "doctrinal"]);
const ARGUMENT_ROLES = new Set(["premise", "assumption", "objection", "response", "counter_response", "evidence"]);
const PATH_TYPES = new Set(["guided", "study", "debate", "evidence", "compare", "article"]);
const JOURNEY_REVIEW_DIMENSIONS = new Set(["source", "doctrinal", "editorial", "historical", "translation", "licensing", "provenance"]);
const REVIEW_STATES = new Set(["approved", "requires_revision", "rejected", "contested"]);

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function jsonArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function editableState(value: unknown) {
  const state = parseContentState(value);
  if (state === "published") throw new KnowledgeInputError("publish through the reviewed publication endpoint");
  return state;
}
function canonicalIds(value: unknown, field: string, maximum = 250): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new KnowledgeInputError(`${field} must be an array`);
  if (value.length > maximum) throw new KnowledgeInputError(`${field} exceeds ${maximum} entries`);
  return value.map((entry, index) => assertCanonicalId(entry, `${field}[${index}]`));
}
async function requireNodes(ids: string[], options: { published?: boolean } = {}): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await queryKnowledge<{ id: string }>(
    `SELECT id FROM knowledge_nodes WHERE id=ANY($1::text[]) ${options.published ? "AND published_revision_id IS NOT NULL" : ""}`,
    [unique]
  );
  if (rows.length !== unique.length) {
    if (options.published) throw new KnowledgeConflictError("all referenced nodes must be published");
    throw new KnowledgeNotFoundError("one or more referenced nodes do not exist");
  }
}
async function requireTopic(topicId: string, options: { published?: boolean } = {}): Promise<void> {
  const rows = await queryKnowledge<{ id: string }>(
    `SELECT id FROM knowledge_topics WHERE id=$1 ${options.published ? "AND published_revision_id IS NOT NULL" : ""}`,
    [topicId]
  );
  if (!rows[0]) {
    if (options.published) throw new KnowledgeConflictError("published path topic must itself be published");
    throw new KnowledgeNotFoundError("topic not found");
  }
}
async function nextVersion(client: PoolClient, config: JourneyConfig, id: string): Promise<number> {
  const result = await client.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version),0)+1 AS next_version FROM ${config.versionTable} WHERE ${config.idColumn}=$1`, [id]
  );
  return Number(result.rows[0]?.next_version ?? 1);
}

export function validateTopicDraft(value: unknown): TopicSnapshot {
  const input = requireObject(value);
  const id = input.id ? assertCanonicalId(input.id) : `topic:${stableHash([input.title, input.rootNodeId]).slice(0, 24)}`;
  const rootNodeId = assertCanonicalId(input.rootNodeId, "rootNodeId");
  return {
    id, title: requireText(input.title, "title", 500), rootNodeId,
    summary: optionalText(input.summary, "summary", 20_000),
    featuredNodeIds: canonicalIds(input.featuredNodeIds, "featuredNodeIds", 250),
    contentState: editableState(input.contentState ?? "draft"), metadata: asMetadata(input.metadata),
  };
}
export function validatePathDraft(value: unknown): PathSnapshot {
  const input = requireObject(value);
  const id = input.id ? assertCanonicalId(input.id) : `path:${stableHash([input.title, input.topicId]).slice(0, 24)}`;
  const pathType = optionalText(input.pathType, "pathType", 80) ?? "guided";
  if (!PATH_TYPES.has(pathType)) throw new KnowledgeInputError("unsupported pathType");
  const topicId = input.topicId ? assertCanonicalId(input.topicId, "topicId") : undefined;
  const rawSteps = jsonArray(input.steps);
  if (rawSteps.length === 0) throw new KnowledgeInputError("path requires at least one step");
  if (rawSteps.length > 250) throw new KnowledgeInputError("steps exceeds 250 entries");
  const steps = rawSteps.map((entry, index) => {
    const step = requireObject(entry);
    return { nodeId: assertCanonicalId(step.nodeId, `steps[${index}].nodeId`), role: optionalText(step.role, `steps[${index}].role`, 80) ?? "step", metadata: asMetadata(step.metadata) };
  });
  return {
    id, topicId, title: requireText(input.title, "title", 500), pathType,
    description: optionalText(input.description, "description", 20_000), steps,
    contentState: editableState(input.contentState ?? "draft"), metadata: asMetadata(input.metadata),
  };
}
export function validateArgumentDraft(value: unknown): ArgumentSnapshot {
  const input = requireObject(value);
  const argumentType = requireText(input.argumentType, "argumentType", 80);
  if (!ARGUMENT_TYPES.has(argumentType)) throw new KnowledgeInputError("unsupported argumentType");
  const conclusionNodeId = assertCanonicalId(input.conclusionNodeId, "conclusionNodeId");
  const rawMembers = jsonArray(input.members);
  if (rawMembers.length > 500) throw new KnowledgeInputError("members exceeds 500 entries");
  const members = rawMembers.map((entry, index) => {
    const member = requireObject(entry);
    const role = requireText(member.role, `members[${index}].role`, 80);
    if (!ARGUMENT_ROLES.has(role)) throw new KnowledgeInputError(`unsupported argument member role: ${role}`);
    return { nodeId: assertCanonicalId(member.nodeId, `members[${index}].nodeId`), role, position: Number.isInteger(member.position) && Number(member.position) >= 0 ? Number(member.position) : index, metadata: asMetadata(member.metadata) };
  });
  const id = input.id ? assertCanonicalId(input.id) : `argument:${stableHash([input.title, conclusionNodeId]).slice(0, 24)}`;
  return {
    id, title: requireText(input.title, "title", 500), argumentType, conclusionNodeId, members,
    contentState: editableState(input.contentState ?? "draft"), metadata: asMetadata(input.metadata),
  };
}

async function replaceTopicNodes(client: PoolClient, topicId: string, snapshot: TopicSnapshot) {
  await client.query(`DELETE FROM knowledge_topic_nodes WHERE topic_id=$1`, [topicId]);
  const ids = [snapshot.rootNodeId, ...snapshot.featuredNodeIds];
  for (let index = 0; index < ids.length; index += 1) {
    await client.query(`INSERT INTO knowledge_topic_nodes(topic_id,node_id,role,position) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [topicId, ids[index], index === 0 ? "root" : "featured", index]);
  }
}
async function replacePathNodes(client: PoolClient, pathId: string, snapshot: PathSnapshot) {
  await client.query(`DELETE FROM knowledge_path_nodes WHERE path_id=$1`, [pathId]);
  for (let index = 0; index < snapshot.steps.length; index += 1) {
    const step = snapshot.steps[index]!;
    await client.query(`INSERT INTO knowledge_path_nodes(path_id,node_id,position,step_role,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`, [pathId, step.nodeId, index, step.role, JSON.stringify(step.metadata)]);
  }
}
async function replaceArgumentMembers(client: PoolClient, argumentId: string, snapshot: ArgumentSnapshot) {
  await client.query(`DELETE FROM knowledge_argument_members WHERE argument_id=$1`, [argumentId]);
  for (const member of snapshot.members) {
    await client.query(`INSERT INTO knowledge_argument_members(argument_id,node_id,role,position,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`, [argumentId, member.nodeId, member.role, member.position, JSON.stringify(member.metadata)]);
  }
}

export async function createTopic(value: unknown, actor: string) {
  const snapshot = validateTopicDraft(value); await requireNodes([snapshot.rootNodeId, ...snapshot.featuredNodeIds]);
  return withKnowledgeTransaction(async (client) => {
    const revision = revisionId("topic");
    await client.query(`INSERT INTO knowledge_topics(id,title,root_node_id,summary,content_state,current_revision_id,published_revision_id,metadata) VALUES($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)`, [snapshot.id, snapshot.title, snapshot.rootNodeId, snapshot.summary ?? null, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]);
    await client.query(`INSERT INTO knowledge_topic_versions(revision_id,topic_id,version,content_hash,snapshot,created_by) VALUES($1,$2,1,$3,$4::jsonb,$5)`, [revision, snapshot.id, stableHash(snapshot), JSON.stringify(snapshot), actor]);
    await replaceTopicNodes(client, snapshot.id, snapshot); return { ...snapshot, currentRevisionId: revision, publishedRevisionId: null };
  });
}
export async function reviseTopic(idValue: unknown, value: unknown, actor: string) {
  const id = assertCanonicalId(idValue, "id"); const snapshot = validateTopicDraft({ ...requireObject(value), id });
  await requireNodes([snapshot.rootNodeId, ...snapshot.featuredNodeIds]);
  return withKnowledgeTransaction(async (client) => {
    const current = await client.query(`SELECT * FROM knowledge_topics WHERE id=$1 FOR UPDATE`, [id]);
    if (!current.rows[0]) throw new KnowledgeNotFoundError("topic not found");
    const revision = revisionId("topic"); const version = await nextVersion(client, CONFIG.topic, id);
    await client.query(`INSERT INTO knowledge_topic_versions(revision_id,topic_id,version,content_hash,snapshot,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [revision, id, version, stableHash(snapshot), JSON.stringify(snapshot), actor]);
    if (current.rows[0].published_revision_id) await client.query(`UPDATE knowledge_topics SET current_revision_id=$2,updated_at=NOW() WHERE id=$1`, [id, revision]);
    else { await client.query(`UPDATE knowledge_topics SET title=$2,root_node_id=$3,summary=$4,content_state=$5,current_revision_id=$6,metadata=$7::jsonb,updated_at=NOW() WHERE id=$1`, [id, snapshot.title, snapshot.rootNodeId, snapshot.summary ?? null, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]); await replaceTopicNodes(client, id, snapshot); }
    return { ...snapshot, currentRevisionId: revision, publishedRevisionId: current.rows[0].published_revision_id ? String(current.rows[0].published_revision_id) : null };
  });
}
export async function createPath(value: unknown, actor: string) {
  const snapshot = validatePathDraft(value); await requireNodes(snapshot.steps.map((step) => step.nodeId)); if (snapshot.topicId) await requireTopic(snapshot.topicId);
  return withKnowledgeTransaction(async (client) => {
    const revision = revisionId("path");
    await client.query(`INSERT INTO knowledge_paths(id,topic_id,title,path_type,description,content_state,current_revision_id,published_revision_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8::jsonb)`, [snapshot.id, snapshot.topicId ?? null, snapshot.title, snapshot.pathType, snapshot.description ?? null, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]);
    await client.query(`INSERT INTO knowledge_path_versions(revision_id,path_id,version,content_hash,snapshot,created_by) VALUES($1,$2,1,$3,$4::jsonb,$5)`, [revision, snapshot.id, stableHash(snapshot), JSON.stringify(snapshot), actor]);
    await replacePathNodes(client, snapshot.id, snapshot); return { ...snapshot, currentRevisionId: revision, publishedRevisionId: null };
  });
}
export async function revisePath(idValue: unknown, value: unknown, actor: string) {
  const id = assertCanonicalId(idValue, "id"); const snapshot = validatePathDraft({ ...requireObject(value), id });
  await requireNodes(snapshot.steps.map((step) => step.nodeId)); if (snapshot.topicId) await requireTopic(snapshot.topicId);
  return withKnowledgeTransaction(async (client) => {
    const current = await client.query(`SELECT * FROM knowledge_paths WHERE id=$1 FOR UPDATE`, [id]); if (!current.rows[0]) throw new KnowledgeNotFoundError("path not found");
    const revision = revisionId("path"); const version = await nextVersion(client, CONFIG.path, id);
    await client.query(`INSERT INTO knowledge_path_versions(revision_id,path_id,version,content_hash,snapshot,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [revision, id, version, stableHash(snapshot), JSON.stringify(snapshot), actor]);
    if (current.rows[0].published_revision_id) await client.query(`UPDATE knowledge_paths SET current_revision_id=$2,updated_at=NOW() WHERE id=$1`, [id, revision]);
    else { await client.query(`UPDATE knowledge_paths SET topic_id=$2,title=$3,path_type=$4,description=$5,content_state=$6,current_revision_id=$7,metadata=$8::jsonb,updated_at=NOW() WHERE id=$1`, [id, snapshot.topicId ?? null, snapshot.title, snapshot.pathType, snapshot.description ?? null, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]); await replacePathNodes(client, id, snapshot); }
    return { ...snapshot, currentRevisionId: revision, publishedRevisionId: current.rows[0].published_revision_id ? String(current.rows[0].published_revision_id) : null };
  });
}
export async function createArgument(value: unknown, actor: string) {
  const snapshot = validateArgumentDraft(value); await requireNodes([snapshot.conclusionNodeId, ...snapshot.members.map((member) => member.nodeId)]);
  return withKnowledgeTransaction(async (client) => {
    const revision = revisionId("argument");
    await client.query(`INSERT INTO knowledge_arguments(id,title,argument_type,conclusion_node_id,content_state,current_revision_id,published_revision_id,metadata) VALUES($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)`, [snapshot.id, snapshot.title, snapshot.argumentType, snapshot.conclusionNodeId, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]);
    await client.query(`INSERT INTO knowledge_argument_versions(revision_id,argument_id,version,content_hash,snapshot,created_by) VALUES($1,$2,1,$3,$4::jsonb,$5)`, [revision, snapshot.id, stableHash(snapshot), JSON.stringify(snapshot), actor]); await replaceArgumentMembers(client, snapshot.id, snapshot);
    return { ...snapshot, currentRevisionId: revision, publishedRevisionId: null };
  });
}
export async function reviseArgument(idValue: unknown, value: unknown, actor: string) {
  const id = assertCanonicalId(idValue, "id"); const snapshot = validateArgumentDraft({ ...requireObject(value), id }); await requireNodes([snapshot.conclusionNodeId, ...snapshot.members.map((member) => member.nodeId)]);
  return withKnowledgeTransaction(async (client) => {
    const current = await client.query(`SELECT * FROM knowledge_arguments WHERE id=$1 FOR UPDATE`, [id]); if (!current.rows[0]) throw new KnowledgeNotFoundError("argument not found");
    const revision = revisionId("argument"); const version = await nextVersion(client, CONFIG.argument, id);
    await client.query(`INSERT INTO knowledge_argument_versions(revision_id,argument_id,version,content_hash,snapshot,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [revision, id, version, stableHash(snapshot), JSON.stringify(snapshot), actor]);
    if (current.rows[0].published_revision_id) await client.query(`UPDATE knowledge_arguments SET current_revision_id=$2,updated_at=NOW() WHERE id=$1`, [id, revision]);
    else { await client.query(`UPDATE knowledge_arguments SET title=$2,argument_type=$3,conclusion_node_id=$4,content_state=$5,current_revision_id=$6,metadata=$7::jsonb,updated_at=NOW() WHERE id=$1`, [id, snapshot.title, snapshot.argumentType, snapshot.conclusionNodeId, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]); await replaceArgumentMembers(client, id, snapshot); }
    return { ...snapshot, currentRevisionId: revision, publishedRevisionId: current.rows[0].published_revision_id ? String(current.rows[0].published_revision_id) : null };
  });
}

async function getJourney<T extends JourneyTargetType>(targetType: T, idValue: unknown, includeUnpublished = false): Promise<StoredJourney<T> | null> {
  const id = assertCanonicalId(idValue, "id"); const config = CONFIG[targetType];
  const rows = await queryKnowledge(includeUnpublished ? `SELECT a.*,v.snapshot FROM ${config.table} a JOIN ${config.versionTable} v ON v.revision_id=a.current_revision_id WHERE a.id=$1` : `SELECT a.*,v.snapshot FROM ${config.table} a JOIN ${config.versionTable} v ON v.revision_id=a.published_revision_id WHERE a.id=$1 AND a.published_revision_id IS NOT NULL`, [id]);
  if (!rows[0]) return null;
  const snapshot = jsonObject((rows[0] as Row).snapshot) as unknown as JourneySnapshotMap[T];
  return { ...snapshot, currentRevisionId: String((rows[0] as Row).current_revision_id), publishedRevisionId: (rows[0] as Row).published_revision_id ? String((rows[0] as Row).published_revision_id) : null } as StoredJourney<T>;
}
export const getTopic = (id: unknown, includeUnpublished = false) => getJourney("topic", id, includeUnpublished);
export const getPath = (id: unknown, includeUnpublished = false) => getJourney("path", id, includeUnpublished);
export const getArgument = (id: unknown, includeUnpublished = false) => getJourney("argument", id, includeUnpublished);

export async function listTopics(limitValue: unknown = 50): Promise<Array<StoredJourney<"topic">>> {
  const limit = Math.max(1, Math.min(100, Number.parseInt(String(limitValue), 10) || 50));
  const rows = await queryKnowledge(`SELECT t.*,v.snapshot FROM knowledge_topics t JOIN knowledge_topic_versions v ON v.revision_id=t.published_revision_id WHERE t.published_revision_id IS NOT NULL ORDER BY t.title LIMIT $1`, [limit]);
  return rows.map((row) => ({ ...(jsonObject((row as Row).snapshot) as unknown as TopicSnapshot), currentRevisionId: String((row as Row).current_revision_id), publishedRevisionId: String((row as Row).published_revision_id) }));
}
export async function getArgumentsForNode(nodeIdValue: unknown): Promise<Array<StoredJourney<"argument">>> {
  const nodeId = assertCanonicalId(nodeIdValue, "nodeId");
  const rows = await queryKnowledge(`SELECT DISTINCT a.*,v.snapshot FROM knowledge_arguments a JOIN knowledge_argument_versions v ON v.revision_id=a.published_revision_id LEFT JOIN knowledge_argument_members m ON m.argument_id=a.id WHERE a.published_revision_id IS NOT NULL AND (a.conclusion_node_id=$1 OR m.node_id=$1) ORDER BY a.title LIMIT 100`, [nodeId]);
  return rows.map((row) => ({ ...(jsonObject((row as Row).snapshot) as unknown as ArgumentSnapshot), currentRevisionId: String((row as Row).current_revision_id), publishedRevisionId: String((row as Row).published_revision_id) }));
}
export async function getArgumentCoverage(idValue: unknown, includeUnpublished = false) {
  const argument = await getArgument(idValue, includeUnpublished); if (!argument) return null;
  const count = (role: string) => argument.members.filter((member) => member.role === role).length;
  const objectionCount = count("objection"), responseCount = count("response") + count("counter_response"), evidenceCount = count("evidence");
  return { argumentId: argument.id, premises: count("premise"), assumptions: count("assumption"), objections: objectionCount, responses: responseCount, evidence: evidenceCount, structuralCoverage: { hasPremise: count("premise") > 0, hasEvidence: evidenceCount > 0, hasObjectionResponse: objectionCount === 0 || responseCount > 0 }, note: "Coverage describes argument structure and editorial completeness; it is not a truth score." };
}

export async function recordJourneyReview(value: unknown, reviewerId: string) {
  const input = requireObject(value); const targetType = requireText(input.targetType, "targetType", 40) as JourneyTargetType;
  if (!CONFIG[targetType]) throw new KnowledgeInputError("targetType must be topic, path, or argument");
  const revision = requireText(input.revisionId, "revisionId", 250), reviewDimension = requireText(input.reviewDimension, "reviewDimension", 80), state = requireText(input.state, "state", 80);
  if (!JOURNEY_REVIEW_DIMENSIONS.has(reviewDimension)) throw new KnowledgeInputError("unsupported review dimension"); if (!REVIEW_STATES.has(state)) throw new KnowledgeInputError("unsupported review state");
  const config = CONFIG[targetType]; const rows = await queryKnowledge(`SELECT content_hash FROM ${config.versionTable} WHERE revision_id=$1`, [revision]); const contentHash = String((rows[0] as Row | undefined)?.content_hash ?? ""); if (!contentHash) throw new KnowledgeNotFoundError("revision not found");
  const id = objectId("review"); await queryKnowledge(`INSERT INTO knowledge_reviews(id,target_type,target_revision_id,review_dimension,state,reviewer_id,notes,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, targetType, revision, reviewDimension, state, reviewerId, optionalText(input.notes, "notes", 10_000) ?? null, contentHash]);
  return { id, targetType, revisionId: revision, reviewDimension, state, reviewerId, contentHash };
}
export async function publishJourneyRevision(value: unknown, actor: string) {
  const input = requireObject(value); const targetType = requireText(input.targetType, "targetType", 40) as JourneyTargetType; const config = CONFIG[targetType]; if (!config) throw new KnowledgeInputError("targetType must be topic, path, or argument");
  const targetId = assertCanonicalId(input.targetId, "targetId"), revision = requireText(input.revisionId, "revisionId", 250);
  return withKnowledgeTransaction(async (client) => {
    const targetRows = await client.query(`SELECT current_revision_id FROM ${config.table} WHERE id=$1 FOR UPDATE`, [targetId]); if (!targetRows.rows[0]) throw new KnowledgeNotFoundError(`${targetType} not found`); if (String(targetRows.rows[0].current_revision_id) !== revision) throw new KnowledgeConflictError("only the current revision can be published");
    const versionRows = await client.query(`SELECT content_hash,snapshot FROM ${config.versionTable} WHERE revision_id=$1 AND ${config.idColumn}=$2`, [revision, targetId]); if (!versionRows.rows[0]) throw new KnowledgeNotFoundError("revision not found for target");
    const contentHash = String(versionRows.rows[0].content_hash), snapshot = jsonObject(versionRows.rows[0].snapshot); const reviews = await client.query(`SELECT review_dimension,state,content_hash FROM knowledge_reviews WHERE target_type=$1 AND target_revision_id=$2`, [targetType, revision]);
    for (const required of config.requiredReviews) if (!reviews.rows.some((row) => row.review_dimension === required && row.state === "approved" && row.content_hash === contentHash)) throw new KnowledgeConflictError(`publication requires approved ${required} review bound to this revision hash`);
    if (targetType === "topic") { const parsed = validateTopicDraft({ ...snapshot, contentState: "approved" }); await requireNodes([parsed.rootNodeId, ...parsed.featuredNodeIds], { published: true }); await client.query(`UPDATE knowledge_topics SET title=$2,root_node_id=$3,summary=$4,content_state='published',published_revision_id=$5,metadata=$6::jsonb,updated_at=NOW() WHERE id=$1`, [targetId, parsed.title, parsed.rootNodeId, parsed.summary ?? null, revision, JSON.stringify(parsed.metadata)]); await replaceTopicNodes(client, targetId, parsed); }
    else if (targetType === "path") { const parsed = validatePathDraft({ ...snapshot, contentState: "approved" }); await requireNodes(parsed.steps.map((step) => step.nodeId), { published: true }); if (parsed.topicId) await requireTopic(parsed.topicId, { published: true }); await client.query(`UPDATE knowledge_paths SET topic_id=$2,title=$3,path_type=$4,description=$5,content_state='published',published_revision_id=$6,metadata=$7::jsonb,updated_at=NOW() WHERE id=$1`, [targetId, parsed.topicId ?? null, parsed.title, parsed.pathType, parsed.description ?? null, revision, JSON.stringify(parsed.metadata)]); await replacePathNodes(client, targetId, parsed); }
    else { const parsed = validateArgumentDraft({ ...snapshot, contentState: "approved" }); await requireNodes([parsed.conclusionNodeId, ...parsed.members.map((member) => member.nodeId)], { published: true }); await client.query(`UPDATE knowledge_arguments SET title=$2,argument_type=$3,conclusion_node_id=$4,content_state='published',published_revision_id=$5,metadata=$6::jsonb,updated_at=NOW() WHERE id=$1`, [targetId, parsed.title, parsed.argumentType, parsed.conclusionNodeId, revision, JSON.stringify(parsed.metadata)]); await replaceArgumentMembers(client, targetId, parsed); }
    const eventId = objectId("publication"); await client.query(`INSERT INTO knowledge_publication_events(id,target_type,target_id,revision_id,action,actor_id,content_hash) VALUES($1,$2,$3,$4,'published',$5,$6)`, [eventId, targetType, targetId, revision, actor, contentHash]);
    return { published: true, targetType, targetId, revisionId: revision, contentHash, eventId };
  });
}
