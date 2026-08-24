import { queryKnowledge, withKnowledgeTransaction } from "./db";
import {
  asMetadata,
  assertCanonicalId,
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

type JourneyConfig = {
  table: string;
  versionTable: string;
  idColumn: string;
  revisionPrefix: string;
  requiredReviews: string[];
};

const CONFIG: Record<JourneyTargetType, JourneyConfig> = {
  topic: {
    table: "knowledge_topics",
    versionTable: "knowledge_topic_versions",
    idColumn: "topic_id",
    revisionPrefix: "topic",
    requiredReviews: ["doctrinal", "editorial"],
  },
  path: {
    table: "knowledge_paths",
    versionTable: "knowledge_path_versions",
    idColumn: "path_id",
    revisionPrefix: "path",
    requiredReviews: ["doctrinal", "editorial"],
  },
  argument: {
    table: "knowledge_arguments",
    versionTable: "knowledge_argument_versions",
    idColumn: "argument_id",
    revisionPrefix: "argument",
    requiredReviews: ["source", "doctrinal"],
  },
};

const ARGUMENT_TYPES = new Set([
  "deductive",
  "inductive",
  "abductive",
  "historical",
  "textual",
  "linguistic",
  "philosophical",
  "typological",
  "patristic",
  "doctrinal",
]);

const ARGUMENT_ROLES = new Set([
  "premise",
  "assumption",
  "objection",
  "response",
  "counter_response",
  "evidence",
]);

const PATH_TYPES = new Set(["guided", "study", "debate", "evidence", "compare", "article"]);
const JOURNEY_REVIEW_DIMENSIONS = new Set(["source", "doctrinal", "editorial", "historical", "translation", "licensing", "provenance"]);
const REVIEW_STATES = new Set(["approved", "requires_revision", "rejected", "contested"]);

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function ensureEditableState(value: unknown) {
  const state = parseContentState(value);
  if (state === "published") throw new Error("publish through the reviewed publication endpoint");
  return state;
}

function canonicalIds(value: unknown, field: string, maximum = 250): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} entries`);
  return value.map((entry, index) => assertCanonicalId(entry, `${field}[${index}]`));
}

async function requireNodes(ids: string[], { published = false }: { published?: boolean } = {}): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await queryKnowledge<{ id: string }>(
    `SELECT id FROM knowledge_nodes WHERE id=ANY($1::text[]) ${published ? "AND published_revision_id IS NOT NULL" : ""}`,
    [unique]
  );
  if (rows.length !== unique.length) {
    throw new Error(published ? "all referenced nodes must be published" : "one or more referenced nodes do not exist");
  }
}

async function nextVersion(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }> }, config: JourneyConfig, id: string): Promise<number> {
  const result = await client.query(
    `SELECT COALESCE(MAX(version),0)+1 AS next_version FROM ${config.versionTable} WHERE ${config.idColumn}=$1`,
    [id]
  );
  return Number(result.rows[0]?.next_version ?? 1);
}

function parseTopic(value: unknown) {
  const input = requireObject(value);
  const id = input.id ? assertCanonicalId(input.id) : `topic:${stableHash([input.title, input.rootNodeId]).slice(0, 24)}`;
  const rootNodeId = assertCanonicalId(input.rootNodeId, "rootNodeId");
  const featuredNodeIds = canonicalIds(input.featuredNodeIds, "featuredNodeIds", 250);
  return {
    id,
    title: requireText(input.title, "title", 500),
    rootNodeId,
    summary: optionalText(input.summary, "summary", 20_000),
    featuredNodeIds,
    contentState: ensureEditableState(input.contentState ?? "draft"),
    metadata: asMetadata(input.metadata),
  };
}

function parsePath(value: unknown) {
  const input = requireObject(value);
  const id = input.id ? assertCanonicalId(input.id) : `path:${stableHash([input.title, input.topicId]).slice(0, 24)}`;
  const pathType = optionalText(input.pathType, "pathType", 80) ?? "guided";
  if (!PATH_TYPES.has(pathType)) throw new Error("unsupported pathType");
  const topicId = input.topicId ? assertCanonicalId(input.topicId, "topicId") : undefined;
  const rawSteps = jsonArray(input.steps);
  if (rawSteps.length === 0) throw new Error("path requires at least one step");
  if (rawSteps.length > 250) throw new Error("steps exceeds 250 entries");
  const steps = rawSteps.map((entry, index) => {
    const step = requireObject(entry);
    return {
      nodeId: assertCanonicalId(step.nodeId, `steps[${index}].nodeId`),
      role: optionalText(step.role, `steps[${index}].role`, 80) ?? "step",
      metadata: asMetadata(step.metadata),
    };
  });
  return {
    id,
    topicId,
    title: requireText(input.title, "title", 500),
    pathType,
    description: optionalText(input.description, "description", 20_000),
    steps,
    contentState: ensureEditableState(input.contentState ?? "draft"),
    metadata: asMetadata(input.metadata),
  };
}

function parseArgument(value: unknown) {
  const input = requireObject(value);
  const argumentType = requireText(input.argumentType, "argumentType", 80);
  if (!ARGUMENT_TYPES.has(argumentType)) throw new Error("unsupported argumentType");
  const conclusionNodeId = assertCanonicalId(input.conclusionNodeId, "conclusionNodeId");
  const rawMembers = jsonArray(input.members);
  if (rawMembers.length > 500) throw new Error("members exceeds 500 entries");
  const members = rawMembers.map((entry, index) => {
    const member = requireObject(entry);
    const role = requireText(member.role, `members[${index}].role`, 80);
    if (!ARGUMENT_ROLES.has(role)) throw new Error(`unsupported argument member role: ${role}`);
    return {
      nodeId: assertCanonicalId(member.nodeId, `members[${index}].nodeId`),
      role,
      position: Number.isInteger(member.position) && Number(member.position) >= 0 ? Number(member.position) : index,
      metadata: asMetadata(member.metadata),
    };
  });
  const id = input.id ? assertCanonicalId(input.id) : `argument:${stableHash([input.title, conclusionNodeId]).slice(0, 24)}`;
  return {
    id,
    title: requireText(input.title, "title", 500),
    argumentType,
    conclusionNodeId,
    members,
    contentState: ensureEditableState(input.contentState ?? "draft"),
    metadata: asMetadata(input.metadata),
  };
}

async function replaceTopicNodes(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, topicId: string, snapshot: ReturnType<typeof parseTopic>) {
  await client.query(`DELETE FROM knowledge_topic_nodes WHERE topic_id=$1`, [topicId]);
  const ids = [snapshot.rootNodeId, ...snapshot.featuredNodeIds];
  for (let index = 0; index < ids.length; index += 1) {
    const role = index === 0 ? "root" : "featured";
    await client.query(
      `INSERT INTO knowledge_topic_nodes(topic_id,node_id,role,position) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [topicId, ids[index], role, index]
    );
  }
}

async function replacePathNodes(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, pathId: string, snapshot: ReturnType<typeof parsePath>) {
  await client.query(`DELETE FROM knowledge_path_nodes WHERE path_id=$1`, [pathId]);
  for (let index = 0; index < snapshot.steps.length; index += 1) {
    const step = snapshot.steps[index]!;
    await client.query(
      `INSERT INTO knowledge_path_nodes(path_id,node_id,position,step_role,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [pathId, step.nodeId, index, step.role, JSON.stringify(step.metadata)]
    );
  }
}

async function replaceArgumentMembers(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, argumentId: string, snapshot: ReturnType<typeof parseArgument>) {
  await client.query(`DELETE FROM knowledge_argument_members WHERE argument_id=$1`, [argumentId]);
  for (const member of snapshot.members) {
    await client.query(
      `INSERT INTO knowledge_argument_members(argument_id,node_id,role,position,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [argumentId, member.nodeId, member.role, member.position, JSON.stringify(member.metadata)]
    );
  }
}

export async function createTopic(value: unknown, actor: string) {
  const snapshot = parseTopic(value);
  await requireNodes([snapshot.rootNodeId, ...snapshot.featuredNodeIds]);
  return withKnowledgeTransaction(async (client) => {
    const revision = revisionId("topic");
    await client.query(
      `INSERT INTO knowledge_topics(id,title,root_node_id,summary,content_state,current_revision_id,published_revision_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)`,
      [snapshot.id, snapshot.title, snapshot.rootNodeId, snapshot.summary ?? null, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]
    );
    await client.query(
      `INSERT INTO knowledge_topic_versions(revision_id,topic_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,1,$3,$4::jsonb,$5)`,
      [revision, snapshot.id, stableHash(snapshot), JSON.stringify(snapshot), actor]
    );
    await replaceTopicNodes(client, snapshot.id, snapshot);
    return { ...snapshot, currentRevisionId: revision, publishedRevisionId: null };
  });
}

export async function reviseTopic(idValue: unknown, value: unknown, actor: string) {
  const id = assertCanonicalId(idValue, "id");
  const requested = parseTopic({ ...requireObject(value), id });
  await requireNodes([requested.rootNodeId, ...requested.featuredNodeIds]);
  return withKnowledgeTransaction(async (client) => {
    const current = await client.query(`SELECT * FROM knowledge_topics WHERE id=$1 FOR UPDATE`, [id]);
    if (!current.rows[0]) throw new Error("topic not found");
    const revision = revisionId("topic");
    const version = await nextVersion(client, CONFIG.topic, id);
    await client.query(
      `INSERT INTO knowledge_topic_versions(revision_id,topic_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [revision, id, version, stableHash(requested), JSON.stringify(requested), actor]
    );
    if (current.rows[0].published_revision_id) {
      await client.query(`UPDATE knowledge_topics SET current_revision_id=$2,updated_at=NOW() WHERE id=$1`, [id, revision]);
    } else {
      await client.query(
        `UPDATE knowledge_topics SET title=$2,root_node_id=$3,summary=$4,content_state=$5,current_revision_id=$6,metadata=$7::jsonb,updated_at=NOW() WHERE id=$1`,
        [id, requested.title, requested.rootNodeId, requested.summary ?? null, requested.contentState, revision, JSON.stringify(requested.metadata)]
      );
      await replaceTopicNodes(client, id, requested);
    }
    return { ...requested, currentRevisionId: revision, publishedRevisionId: current.rows[0].published_revision_id ?? null };
  });
}

export async function createPath(value: unknown, actor: string) {
  const snapshot = parsePath(value);
  await requireNodes(snapshot.steps.map((step) => step.nodeId));
  return withKnowledgeTransaction(async (client) => {
    if (snapshot.topicId) {
      const topic = await client.query(`SELECT id FROM knowledge_topics WHERE id=$1`, [snapshot.topicId]);
      if (!topic.rows[0]) throw new Error("topic not found");
    }
    const revision = revisionId("path");
    await client.query(
      `INSERT INTO knowledge_paths(id,topic_id,title,path_type,description,content_state,current_revision_id,published_revision_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8::jsonb)`,
      [snapshot.id, snapshot.topicId ?? null, snapshot.title, snapshot.pathType, snapshot.description ?? null, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]
    );
    await client.query(
      `INSERT INTO knowledge_path_versions(revision_id,path_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,1,$3,$4::jsonb,$5)`,
      [revision, snapshot.id, stableHash(snapshot), JSON.stringify(snapshot), actor]
    );
    await replacePathNodes(client, snapshot.id, snapshot);
    return { ...snapshot, currentRevisionId: revision, publishedRevisionId: null };
  });
}

export async function revisePath(idValue: unknown, value: unknown, actor: string) {
  const id = assertCanonicalId(idValue, "id");
  const snapshot = parsePath({ ...requireObject(value), id });
  await requireNodes(snapshot.steps.map((step) => step.nodeId));
  return withKnowledgeTransaction(async (client) => {
    const current = await client.query(`SELECT * FROM knowledge_paths WHERE id=$1 FOR UPDATE`, [id]);
    if (!current.rows[0]) throw new Error("path not found");
    const revision = revisionId("path");
    const version = await nextVersion(client, CONFIG.path, id);
    await client.query(
      `INSERT INTO knowledge_path_versions(revision_id,path_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [revision, id, version, stableHash(snapshot), JSON.stringify(snapshot), actor]
    );
    if (current.rows[0].published_revision_id) {
      await client.query(`UPDATE knowledge_paths SET current_revision_id=$2,updated_at=NOW() WHERE id=$1`, [id, revision]);
    } else {
      await client.query(
        `UPDATE knowledge_paths SET topic_id=$2,title=$3,path_type=$4,description=$5,content_state=$6,current_revision_id=$7,metadata=$8::jsonb,updated_at=NOW() WHERE id=$1`,
        [id, snapshot.topicId ?? null, snapshot.title, snapshot.pathType, snapshot.description ?? null, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]
      );
      await replacePathNodes(client, id, snapshot);
    }
    return { ...snapshot, currentRevisionId: revision, publishedRevisionId: current.rows[0].published_revision_id ?? null };
  });
}

export async function createArgument(value: unknown, actor: string) {
  const snapshot = parseArgument(value);
  await requireNodes([snapshot.conclusionNodeId, ...snapshot.members.map((member) => member.nodeId)]);
  return withKnowledgeTransaction(async (client) => {
    const revision = revisionId("argument");
    await client.query(
      `INSERT INTO knowledge_arguments(id,title,argument_type,conclusion_node_id,content_state,current_revision_id,published_revision_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)`,
      [snapshot.id, snapshot.title, snapshot.argumentType, snapshot.conclusionNodeId, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]
    );
    await client.query(
      `INSERT INTO knowledge_argument_versions(revision_id,argument_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,1,$3,$4::jsonb,$5)`,
      [revision, snapshot.id, stableHash(snapshot), JSON.stringify(snapshot), actor]
    );
    await replaceArgumentMembers(client, snapshot.id, snapshot);
    return { ...snapshot, currentRevisionId: revision, publishedRevisionId: null };
  });
}

export async function reviseArgument(idValue: unknown, value: unknown, actor: string) {
  const id = assertCanonicalId(idValue, "id");
  const snapshot = parseArgument({ ...requireObject(value), id });
  await requireNodes([snapshot.conclusionNodeId, ...snapshot.members.map((member) => member.nodeId)]);
  return withKnowledgeTransaction(async (client) => {
    const current = await client.query(`SELECT * FROM knowledge_arguments WHERE id=$1 FOR UPDATE`, [id]);
    if (!current.rows[0]) throw new Error("argument not found");
    const revision = revisionId("argument");
    const version = await nextVersion(client, CONFIG.argument, id);
    await client.query(
      `INSERT INTO knowledge_argument_versions(revision_id,argument_id,version,content_hash,snapshot,created_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [revision, id, version, stableHash(snapshot), JSON.stringify(snapshot), actor]
    );
    if (current.rows[0].published_revision_id) {
      await client.query(`UPDATE knowledge_arguments SET current_revision_id=$2,updated_at=NOW() WHERE id=$1`, [id, revision]);
    } else {
      await client.query(
        `UPDATE knowledge_arguments SET title=$2,argument_type=$3,conclusion_node_id=$4,content_state=$5,current_revision_id=$6,metadata=$7::jsonb,updated_at=NOW() WHERE id=$1`,
        [id, snapshot.title, snapshot.argumentType, snapshot.conclusionNodeId, snapshot.contentState, revision, JSON.stringify(snapshot.metadata)]
      );
      await replaceArgumentMembers(client, id, snapshot);
    }
    return { ...snapshot, currentRevisionId: revision, publishedRevisionId: current.rows[0].published_revision_id ?? null };
  });
}

async function getJourney(targetType: JourneyTargetType, idValue: unknown, includeUnpublished = false) {
  const id = assertCanonicalId(idValue, "id");
  const config = CONFIG[targetType];
  const rows = await queryKnowledge(
    includeUnpublished
      ? `SELECT a.*,v.snapshot FROM ${config.table} a JOIN ${config.versionTable} v ON v.revision_id=a.current_revision_id WHERE a.id=$1`
      : `SELECT a.*,v.snapshot FROM ${config.table} a JOIN ${config.versionTable} v ON v.revision_id=a.published_revision_id WHERE a.id=$1 AND a.published_revision_id IS NOT NULL`,
    [id]
  );
  if (!rows[0]) return null;
  return {
    ...jsonObject((rows[0] as Row).snapshot),
    currentRevisionId: String((rows[0] as Row).current_revision_id),
    publishedRevisionId: (rows[0] as Row).published_revision_id ? String((rows[0] as Row).published_revision_id) : null,
  };
}

export const getTopic = (id: unknown, includeUnpublished = false) => getJourney("topic", id, includeUnpublished);
export const getPath = (id: unknown, includeUnpublished = false) => getJourney("path", id, includeUnpublished);
export const getArgument = (id: unknown, includeUnpublished = false) => getJourney("argument", id, includeUnpublished);

export async function listTopics(limitValue: unknown = 50) {
  const limit = Math.max(1, Math.min(100, Number.parseInt(String(limitValue), 10) || 50));
  const rows = await queryKnowledge(
    `SELECT t.*,v.snapshot FROM knowledge_topics t JOIN knowledge_topic_versions v ON v.revision_id=t.published_revision_id
     WHERE t.published_revision_id IS NOT NULL ORDER BY t.title LIMIT $1`,
    [limit]
  );
  return rows.map((row) => ({
    ...jsonObject((row as Row).snapshot),
    currentRevisionId: String((row as Row).current_revision_id),
    publishedRevisionId: String((row as Row).published_revision_id),
  }));
}

export async function getArgumentsForNode(nodeIdValue: unknown) {
  const nodeId = assertCanonicalId(nodeIdValue, "nodeId");
  const rows = await queryKnowledge(
    `SELECT DISTINCT a.*,v.snapshot FROM knowledge_arguments a
     JOIN knowledge_argument_versions v ON v.revision_id=a.published_revision_id
     LEFT JOIN knowledge_argument_members m ON m.argument_id=a.id
     WHERE a.published_revision_id IS NOT NULL AND (a.conclusion_node_id=$1 OR m.node_id=$1)
     ORDER BY a.title LIMIT 100`,
    [nodeId]
  );
  return rows.map((row) => ({ ...jsonObject((row as Row).snapshot), publishedRevisionId: String((row as Row).published_revision_id) }));
}

export async function getArgumentCoverage(idValue: unknown, includeUnpublished = false) {
  const argument = await getArgument(idValue, includeUnpublished);
  if (!argument) return null;
  const members = jsonArray(argument.members).map((entry) => jsonObject(entry));
  const count = (role: string) => members.filter((member) => member.role === role).length;
  const evidenceNodeIds = members.filter((member) => member.role === "evidence").map((member) => String(member.nodeId));
  const objectionNodeIds = members.filter((member) => member.role === "objection").map((member) => String(member.nodeId));
  const responseNodeIds = members.filter((member) => member.role === "response" || member.role === "counter_response").map((member) => String(member.nodeId));
  return {
    argumentId: String(argument.id),
    premises: count("premise"),
    assumptions: count("assumption"),
    objections: objectionNodeIds.length,
    responses: responseNodeIds.length,
    evidence: evidenceNodeIds.length,
    structuralCoverage: {
      hasPremise: count("premise") > 0,
      hasEvidence: evidenceNodeIds.length > 0,
      hasObjectionResponse: objectionNodeIds.length === 0 || responseNodeIds.length > 0,
    },
    note: "Coverage describes argument structure and editorial completeness; it is not a truth score.",
  };
}

export async function recordJourneyReview(value: unknown, reviewerId: string) {
  const input = requireObject(value);
  const targetType = requireText(input.targetType, "targetType", 40) as JourneyTargetType;
  if (!CONFIG[targetType]) throw new Error("targetType must be topic, path, or argument");
  const revision = requireText(input.revisionId, "revisionId", 250);
  const reviewDimension = requireText(input.reviewDimension, "reviewDimension", 80);
  const state = requireText(input.state, "state", 80);
  if (!JOURNEY_REVIEW_DIMENSIONS.has(reviewDimension)) throw new Error("unsupported review dimension");
  if (!REVIEW_STATES.has(state)) throw new Error("unsupported review state");
  const config = CONFIG[targetType];
  const rows = await queryKnowledge(
    `SELECT content_hash FROM ${config.versionTable} WHERE revision_id=$1`,
    [revision]
  );
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

export async function publishJourneyRevision(value: unknown, actor: string) {
  const input = requireObject(value);
  const targetType = requireText(input.targetType, "targetType", 40) as JourneyTargetType;
  const config = CONFIG[targetType];
  if (!config) throw new Error("targetType must be topic, path, or argument");
  const targetId = assertCanonicalId(input.targetId, "targetId");
  const revision = requireText(input.revisionId, "revisionId", 250);
  return withKnowledgeTransaction(async (client) => {
    const targetRows = await client.query(`SELECT current_revision_id FROM ${config.table} WHERE id=$1 FOR UPDATE`, [targetId]);
    if (!targetRows.rows[0]) throw new Error(`${targetType} not found`);
    if (String(targetRows.rows[0].current_revision_id) !== revision) throw new Error("only the current revision can be published");
    const versionRows = await client.query(
      `SELECT content_hash,snapshot FROM ${config.versionTable} WHERE revision_id=$1 AND ${config.idColumn}=$2`,
      [revision, targetId]
    );
    if (!versionRows.rows[0]) throw new Error("revision not found for target");
    const contentHash = String(versionRows.rows[0].content_hash);
    const snapshot = jsonObject(versionRows.rows[0].snapshot);
    const reviews = await client.query(
      `SELECT review_dimension,state,content_hash FROM knowledge_reviews WHERE target_type=$1 AND target_revision_id=$2`,
      [targetType, revision]
    );
    for (const required of config.requiredReviews) {
      const approved = reviews.rows.some((row) => row.review_dimension === required && row.state === "approved" && row.content_hash === contentHash);
      if (!approved) throw new Error(`publication requires approved ${required} review bound to this revision hash`);
    }

    if (targetType === "topic") {
      const parsed = parseTopic({ ...snapshot, contentState: "approved" });
      await requireNodes([parsed.rootNodeId, ...parsed.featuredNodeIds], { published: true });
      await client.query(
        `UPDATE knowledge_topics SET title=$2,root_node_id=$3,summary=$4,content_state='published',published_revision_id=$5,metadata=$6::jsonb,updated_at=NOW() WHERE id=$1`,
        [targetId, parsed.title, parsed.rootNodeId, parsed.summary ?? null, revision, JSON.stringify(parsed.metadata)]
      );
      await replaceTopicNodes(client, targetId, parsed);
    } else if (targetType === "path") {
      const parsed = parsePath({ ...snapshot, contentState: "approved" });
      await requireNodes(parsed.steps.map((step) => step.nodeId), { published: true });
      if (parsed.topicId) {
        const topic = await client.query(`SELECT id FROM knowledge_topics WHERE id=$1 AND published_revision_id IS NOT NULL`, [parsed.topicId]);
        if (!topic.rows[0]) throw new Error("published path topic must itself be published");
      }
      await client.query(
        `UPDATE knowledge_paths SET topic_id=$2,title=$3,path_type=$4,description=$5,content_state='published',published_revision_id=$6,metadata=$7::jsonb,updated_at=NOW() WHERE id=$1`,
        [targetId, parsed.topicId ?? null, parsed.title, parsed.pathType, parsed.description ?? null, revision, JSON.stringify(parsed.metadata)]
      );
      await replacePathNodes(client, targetId, parsed);
    } else {
      const parsed = parseArgument({ ...snapshot, contentState: "approved" });
      await requireNodes([parsed.conclusionNodeId, ...parsed.members.map((member) => member.nodeId)], { published: true });
      await client.query(
        `UPDATE knowledge_arguments SET title=$2,argument_type=$3,conclusion_node_id=$4,content_state='published',published_revision_id=$5,metadata=$6::jsonb,updated_at=NOW() WHERE id=$1`,
        [targetId, parsed.title, parsed.argumentType, parsed.conclusionNodeId, revision, JSON.stringify(parsed.metadata)]
      );
      await replaceArgumentMembers(client, targetId, parsed);
    }

    const eventId = objectId("publication");
    await client.query(
      `INSERT INTO knowledge_publication_events(id,target_type,target_id,revision_id,action,actor_id,content_hash)
       VALUES($1,$2,$3,$4,'published',$5,$6)`,
      [eventId, targetType, targetId, revision, actor, contentHash]
    );
    return { published: true, targetType, targetId, revisionId: revision, contentHash, eventId };
  });
}
