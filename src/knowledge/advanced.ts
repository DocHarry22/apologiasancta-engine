import { queryKnowledge, withKnowledgeTransaction } from "./db";
import { assertCanonicalId, objectId, requireObject, requireText, stableHash } from "./validation";

const MAX_TIMELINE = 200;
const MAX_COMPARE_NEIGHBORS = 60;
const MAX_PATH_DEPTH = 4;
const MAX_PROPOSALS = 100;
const PROPOSAL_TYPES = new Set([
  "duplicate_candidate",
  "candidate_claim",
  "candidate_relationship",
  "candidate_citation",
  "argument_decomposition",
  "learning_link",
  "missing_evidence",
]);
const PROPOSAL_STATUSES = new Set(["proposed", "accepted", "rejected", "expired"]);

type Row = Record<string, unknown>;

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function parseYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || !/^-?\d{1,6}$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function nodeFromRow(row: Row) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    title: String(row.title),
    proposition: text(row.proposition) ?? undefined,
    summary: text(row.summary) ?? undefined,
    publishedRevisionId: text(row.published_revision_id),
    metadata: jsonObject(row.metadata),
  };
}

function edgeFromRow(row: Row) {
  return {
    id: String(row.id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    relationshipType: String(row.relationship_type),
    publishedRevisionId: text(row.published_revision_id),
    metadata: jsonObject(row.metadata),
  };
}

async function recordObservation(
  operation: string,
  startedAt: number,
  counts: { nodeCount?: number; edgeCount?: number; resultCount?: number } = {},
): Promise<{ durationMs: number; nodeCount: number; edgeCount: number; resultCount: number }> {
  const observation = {
    durationMs: Math.max(0, Date.now() - startedAt),
    nodeCount: Math.max(0, counts.nodeCount ?? 0),
    edgeCount: Math.max(0, counts.edgeCount ?? 0),
    resultCount: Math.max(0, counts.resultCount ?? 0),
  };
  await queryKnowledge(
    `INSERT INTO knowledge_query_observations(operation,duration_ms,node_count,edge_count,result_count)
     VALUES($1,$2,$3,$4,$5)`,
    [operation, observation.durationMs, observation.nodeCount, observation.edgeCount, observation.resultCount],
  ).catch(() => []);
  return observation;
}

function timelineDate(metadata: Record<string, unknown>): { year: number; date?: string } | null {
  const rawDate = text(metadata.date) ?? text(metadata.eventDate) ?? text(metadata.startDate);
  if (rawDate) {
    const match = /^(-?\d{1,6})(?:-(\d{2})-(\d{2}))?$/.exec(rawDate);
    if (match) {
      const year = Number.parseInt(match[1]!, 10);
      return { year, ...(match[2] && match[3] ? { date: rawDate } : {}) };
    }
  }
  const year = parseYear(metadata.year ?? metadata.eventYear ?? metadata.startYear);
  return year === null ? null : { year };
}

export async function getPublishedTimeline(options: {
  nodeId?: unknown;
  topicId?: unknown;
  domain?: unknown;
  from?: unknown;
  to?: unknown;
  limit?: unknown;
}) {
  const startedAt = Date.now();
  const nodeId = options.nodeId ? assertCanonicalId(options.nodeId, "nodeId") : null;
  const topicId = options.topicId ? assertCanonicalId(options.topicId, "topicId") : null;
  const domain = typeof options.domain === "string" && options.domain.trim()
    ? options.domain.trim().toLowerCase().slice(0, 80)
    : null;
  const fromYear = parseYear(options.from);
  const toYear = parseYear(options.to);
  const limit = boundedInteger(options.limit, 100, 1, MAX_TIMELINE);
  if (fromYear !== null && toYear !== null && fromYear > toYear) {
    throw new Error("timeline from year must not be after to year");
  }

  const params: unknown[] = [];
  const clauses = ["n.published_revision_id IS NOT NULL", "n.kind='event'"];
  let joins = "";
  if (topicId) {
    params.push(topicId);
    joins += " JOIN knowledge_topic_nodes tn ON tn.node_id=n.id JOIN knowledge_topics t ON t.id=tn.topic_id";
    clauses.push(`t.id=$${params.length}`, "t.published_revision_id IS NOT NULL");
  }
  if (domain) {
    params.push(domain);
    clauses.push(`LOWER(COALESCE(n.metadata->>'domain',''))=$${params.length}`);
  }
  if (nodeId) {
    params.push(nodeId);
    clauses.push(`(n.id=$${params.length} OR EXISTS (
      SELECT 1 FROM knowledge_edges e
      WHERE e.published_revision_id IS NOT NULL
        AND ((e.from_node_id=$${params.length} AND e.to_node_id=n.id)
          OR (e.to_node_id=$${params.length} AND e.from_node_id=n.id))
    ))`);
  }
  params.push(Math.min(MAX_TIMELINE * 3, limit * 3));
  const rows = await queryKnowledge(
    `SELECT DISTINCT n.* FROM knowledge_nodes n${joins}
     WHERE ${clauses.join(" AND ")}
     ORDER BY n.id LIMIT $${params.length}`,
    params,
  );

  const entries = rows
    .map((row) => {
      const node = nodeFromRow(row as Row);
      const chronology = timelineDate(node.metadata);
      if (!chronology) return null;
      const provenanceIds = Array.isArray(node.metadata.provenanceIds)
        ? node.metadata.provenanceIds.filter((value): value is string => typeof value === "string").slice(0, 50)
        : [];
      return { ...chronology, node, provenanceIds };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .filter((entry) => fromYear === null || entry.year >= fromYear)
    .filter((entry) => toYear === null || entry.year <= toYear)
    .sort((a, b) => a.year - b.year || (a.date ?? "").localeCompare(b.date ?? "") || a.node.id.localeCompare(b.node.id))
    .slice(0, limit);

  return {
    entries,
    meta: {
      bounded: true,
      undatedRecordsExcluded: true,
      instrumentation: await recordObservation("timeline", startedAt, { nodeCount: entries.length, resultCount: entries.length }),
    },
  };
}

async function publishedNode(id: string): Promise<Row | null> {
  const rows = await queryKnowledge(`SELECT * FROM knowledge_nodes WHERE id=$1 AND published_revision_id IS NOT NULL`, [id]);
  return (rows[0] as Row | undefined) ?? null;
}

export async function comparePublishedNodes(leftValue: unknown, rightValue: unknown, lensValue?: unknown) {
  const startedAt = Date.now();
  const left = assertCanonicalId(leftValue, "left");
  const right = assertCanonicalId(rightValue, "right");
  if (left === right) throw new Error("left and right must identify different nodes");
  const [leftRow, rightRow] = await Promise.all([publishedNode(left), publishedNode(right)]);
  if (!leftRow || !rightRow) return null;

  const directRows = await queryKnowledge(
    `SELECT * FROM knowledge_edges
     WHERE published_revision_id IS NOT NULL
       AND ((from_node_id=$1 AND to_node_id=$2) OR (from_node_id=$2 AND to_node_id=$1))
     ORDER BY id LIMIT 50`,
    [left, right],
  );
  const sharedRows = await queryKnowledge(
    `WITH l AS (
       SELECT CASE WHEN from_node_id=$1 THEN to_node_id ELSE from_node_id END AS node_id
       FROM knowledge_edges WHERE published_revision_id IS NOT NULL AND (from_node_id=$1 OR to_node_id=$1)
     ), r AS (
       SELECT CASE WHEN from_node_id=$2 THEN to_node_id ELSE from_node_id END AS node_id
       FROM knowledge_edges WHERE published_revision_id IS NOT NULL AND (from_node_id=$2 OR to_node_id=$2)
     )
     SELECT DISTINCT n.* FROM knowledge_nodes n JOIN l ON l.node_id=n.id JOIN r ON r.node_id=n.id
     WHERE n.published_revision_id IS NOT NULL ORDER BY n.id LIMIT $3`,
    [left, right, MAX_COMPARE_NEIGHBORS],
  );
  const relatedIds = [left, right, ...sharedRows.map((row) => String((row as Row).id))];
  const semanticRows = await queryKnowledge(
    `SELECT * FROM knowledge_edges
     WHERE published_revision_id IS NOT NULL
       AND from_node_id=ANY($1::text[]) AND to_node_id=ANY($1::text[])
       AND relationship_type=ANY($2::text[])
     ORDER BY id LIMIT 120`,
    [relatedIds, ["defines", "historically_precedes", "historically_follows", "interprets", "disputes_interpretation_of"]],
  );
  const lens = typeof lensValue === "string" && lensValue.trim() ? lensValue.trim().toLowerCase().slice(0, 80) : null;
  const assessmentParams: unknown[] = [[left, right]];
  let lensClause = "";
  if (lens) {
    assessmentParams.push(lens);
    lensClause = "AND a.lens=$2";
  }
  const assessmentRows = await queryKnowledge(
    `SELECT a.* FROM knowledge_assessments a JOIN knowledge_nodes n ON n.id=a.node_id
     WHERE a.node_id=ANY($1::text[]) AND a.review_state='approved'
       AND a.node_revision_id=n.published_revision_id ${lensClause}
     ORDER BY a.node_id,a.lens LIMIT 100`,
    assessmentParams,
  );
  const pathRows = await queryKnowledge<{ path: string[]; depth: number }>(
    `WITH RECURSIVE walk(node_id,path,depth) AS (
       SELECT $1::text,ARRAY[$1::text],0
       UNION ALL
       SELECT CASE WHEN e.from_node_id=w.node_id THEN e.to_node_id ELSE e.from_node_id END,
              w.path || CASE WHEN e.from_node_id=w.node_id THEN e.to_node_id ELSE e.from_node_id END,
              w.depth+1
       FROM walk w JOIN knowledge_edges e
         ON e.published_revision_id IS NOT NULL AND (e.from_node_id=w.node_id OR e.to_node_id=w.node_id)
       WHERE w.depth<$3
         AND NOT (CASE WHEN e.from_node_id=w.node_id THEN e.to_node_id ELSE e.from_node_id END = ANY(w.path))
     )
     SELECT path,depth FROM walk WHERE node_id=$2 ORDER BY depth LIMIT 1`,
    [left, right, MAX_PATH_DEPTH],
  );

  const edgeCount = directRows.length + semanticRows.length;
  return {
    left: nodeFromRow(leftRow),
    right: nodeFromRow(rightRow),
    directEdges: directRows.map((row) => edgeFromRow(row as Row)),
    sharedNeighbors: sharedRows.map((row) => nodeFromRow(row as Row)),
    semanticRelationships: semanticRows.map((row) => edgeFromRow(row as Row)),
    assessments: assessmentRows.map((row) => ({
      id: String((row as Row).id),
      nodeId: String((row as Row).node_id),
      lens: String((row as Row).lens),
      position: String((row as Row).position),
      rationaleIds: jsonArray((row as Row).rationale_ids),
      sourceIds: jsonArray((row as Row).source_ids),
    })),
    connectingPath: pathRows[0]?.path ?? null,
    meta: {
      bounded: true,
      storedRelationshipsOnly: true,
      instrumentation: await recordObservation("compare", startedAt, {
        nodeCount: 2 + sharedRows.length,
        edgeCount,
        resultCount: directRows.length + sharedRows.length + assessmentRows.length,
      }),
    },
  };
}

export async function getPublishedDebate(argumentIdValue: unknown) {
  const startedAt = Date.now();
  const argumentId = assertCanonicalId(argumentIdValue, "argumentId");
  const argumentsFound = await queryKnowledge(
    `SELECT * FROM knowledge_arguments WHERE id=$1 AND published_revision_id IS NOT NULL`,
    [argumentId],
  );
  const argument = argumentsFound[0] as Row | undefined;
  if (!argument) return null;

  const members = await queryKnowledge(
    `SELECT m.role,m.position,m.metadata AS member_metadata,n.*
     FROM knowledge_argument_members m JOIN knowledge_nodes n ON n.id=m.node_id
     WHERE m.argument_id=$1 AND n.published_revision_id IS NOT NULL
     ORDER BY m.position,m.role,n.id LIMIT 200`,
    [argumentId],
  );
  const objections = members.filter((row) => String((row as Row).kind) === "objection");
  const steps = [];
  for (const objectionRow of objections.slice(0, 40)) {
    const objection = nodeFromRow(objectionRow as Row);
    const responseRows = await queryKnowledge(
      `SELECT e.*,n.id AS response_id,n.kind AS response_kind,n.title AS response_title,
              n.proposition AS response_proposition,n.summary AS response_summary,
              n.published_revision_id AS response_published_revision_id,n.metadata AS response_metadata
       FROM knowledge_edges e JOIN knowledge_nodes n
         ON n.id=CASE WHEN e.from_node_id=$1 THEN e.to_node_id ELSE e.from_node_id END
       WHERE e.published_revision_id IS NOT NULL AND n.published_revision_id IS NOT NULL
         AND e.relationship_type='responds_to'
         AND (e.from_node_id=$1 OR e.to_node_id=$1)
       ORDER BY e.id LIMIT 20`,
      [objection.id],
    );
    steps.push({
      objection,
      candidateResponses: responseRows.map((row) => ({
        edge: edgeFromRow(row as Row),
        node: {
          id: String((row as Row).response_id),
          kind: String((row as Row).response_kind),
          title: String((row as Row).response_title),
          proposition: text((row as Row).response_proposition) ?? undefined,
          summary: text((row as Row).response_summary) ?? undefined,
          publishedRevisionId: text((row as Row).response_published_revision_id),
          metadata: jsonObject((row as Row).response_metadata),
        },
      })),
    });
  }

  const memberNodes = members.map((row) => nodeFromRow(row as Row));
  return {
    argument: {
      id: String(argument.id),
      title: String(argument.title),
      argumentType: String(argument.argument_type),
      conclusionNodeId: String(argument.conclusion_node_id),
      publishedRevisionId: String(argument.published_revision_id),
    },
    steps,
    canonicalNodeIds: [...new Set(memberNodes.map((node) => node.id))],
    scoringDisclosure: "Route completeness and evidence use may be scored; theological truth is never assigned a numeric score.",
    meta: {
      bounded: true,
      unpublishedBranchesExcluded: true,
      instrumentation: await recordObservation("debate", startedAt, {
        nodeCount: memberNodes.length,
        edgeCount: steps.reduce((total, step) => total + step.candidateResponses.length, 0),
        resultCount: steps.length,
      }),
    },
  };
}

export async function getCoverageDashboard() {
  const startedAt = Date.now();
  const [nodeKinds, states, unsupported, provenanceFree, unresolvedAssertions, unanswered, reviewBacklog, citationBacklog, argumentsMissing] = await Promise.all([
    queryKnowledge(`SELECT kind,COUNT(*)::int AS count FROM knowledge_nodes GROUP BY kind ORDER BY kind`),
    queryKnowledge(`SELECT content_state,COUNT(*)::int AS count FROM knowledge_nodes GROUP BY content_state ORDER BY content_state`),
    queryKnowledge(
      `SELECT COUNT(*)::int AS count FROM knowledge_nodes n
       WHERE n.published_revision_id IS NOT NULL AND n.kind=ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_citations c
           WHERE c.node_id=n.id AND c.node_revision_id=n.published_revision_id AND c.review_state='approved'
         )`,
      [["claim", "objection", "response", "conclusion"]],
    ),
    queryKnowledge(
      `SELECT COUNT(*)::int AS count FROM knowledge_edges e
       WHERE e.published_revision_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM knowledge_edge_assertions a
         WHERE a.edge_id=e.id AND a.revision_id=e.published_revision_id AND a.review_state='approved'
       )`,
    ),
    queryKnowledge(`SELECT review_state,COUNT(*)::int AS count FROM knowledge_edge_assertions WHERE review_state<>'approved' GROUP BY review_state ORDER BY review_state`),
    queryKnowledge(
      `SELECT COUNT(*)::int AS count FROM knowledge_nodes o
       WHERE o.kind='objection' AND o.published_revision_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_edges e JOIN knowledge_nodes r
             ON r.id=CASE WHEN e.from_node_id=o.id THEN e.to_node_id ELSE e.from_node_id END
           WHERE e.published_revision_id IS NOT NULL AND e.relationship_type='responds_to'
             AND (e.from_node_id=o.id OR e.to_node_id=o.id) AND r.published_revision_id IS NOT NULL
         )`,
    ),
    queryKnowledge(`SELECT review_dimension,state,COUNT(*)::int AS count FROM knowledge_reviews WHERE state<>'approved' GROUP BY review_dimension,state ORDER BY review_dimension,state`),
    queryKnowledge(`SELECT review_state,COUNT(*)::int AS count FROM knowledge_citations WHERE review_state<>'approved' GROUP BY review_state ORDER BY review_state`),
    queryKnowledge(
      `SELECT COUNT(*)::int AS count FROM knowledge_arguments a
       WHERE a.published_revision_id IS NOT NULL AND (
         NOT EXISTS (SELECT 1 FROM knowledge_argument_members m WHERE m.argument_id=a.id AND m.role='premise')
         OR NOT EXISTS (SELECT 1 FROM knowledge_argument_members m WHERE m.argument_id=a.id AND m.role IN ('conclusion','response'))
       )`,
    ),
  ]);

  const criticalPublishedEdgesWithoutProvenance = Number((provenanceFree[0] as Row | undefined)?.count ?? 0);
  return {
    nodesByKind: nodeKinds,
    nodesByState: states,
    unsupportedPublishedClaimLikeNodes: Number((unsupported[0] as Row | undefined)?.count ?? 0),
    criticalPublishedEdgesWithoutProvenance,
    unresolvedAssertions,
    unansweredPublishedObjections: Number((unanswered[0] as Row | undefined)?.count ?? 0),
    reviewBacklog,
    citationBacklog,
    publishedArgumentsMissingStructuralCoverage: Number((argumentsMissing[0] as Row | undefined)?.count ?? 0),
    critical: criticalPublishedEdgesWithoutProvenance > 0,
    disclosure: "Coverage is editorial QA and structural completeness, not a truth score.",
    meta: {
      bounded: true,
      instrumentation: await recordObservation("coverage", startedAt, {
        resultCount: nodeKinds.length + states.length + unresolvedAssertions.length + reviewBacklog.length + citationBacklog.length,
      }),
    },
  };
}

export interface AuthoringProposalProvider {
  readonly name: string;
  readonly model: string | null;
  propose(type: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

class HeuristicProposalProvider implements AuthoringProposalProvider {
  readonly name = "heuristic";
  readonly model = null;

  async propose(type: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const textInput = text(input.text) ?? text(input.title) ?? text(input.proposition) ?? "";
    const normalized = textInput.trim().replace(/\s+/g, " ").slice(0, 10_000);
    if (type === "candidate_claim") {
      return { candidate: normalized, requiresHumanSourceReview: true, autoPublish: false };
    }
    if (type === "duplicate_candidate") {
      const tokens = [...new Set(normalized.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4))].slice(0, 16);
      return { lexicalTokens: tokens, candidateOnly: true, autoMerge: false };
    }
    if (type === "missing_evidence") {
      return { targetId: text(input.targetId), finding: "Review the target for missing approved citations or assertions.", requiresHumanReview: true };
    }
    return { type, suggestion: normalized || input, requiresHumanReview: true, autoPublish: false, autoMerge: false };
  }
}

export function getAuthoringProposalProvider(): AuthoringProposalProvider {
  return new HeuristicProposalProvider();
}

function proposalFromRow(row: Row) {
  return {
    id: String(row.id),
    proposalType: String(row.proposal_type),
    inputHash: String(row.input_hash),
    provider: String(row.provider),
    model: text(row.model),
    inputSummary: jsonObject(row.input_summary),
    proposal: jsonObject(row.proposal),
    status: String(row.status),
    proposedBy: String(row.proposed_by),
    reviewedBy: text(row.reviewed_by),
    reviewNotes: text(row.review_notes),
    acceptedMutationIds: jsonArray(row.accepted_mutation_ids),
    createdAt: new Date(String(row.created_at)).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(String(row.reviewed_at)).toISOString() : null,
    expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function createAuthoringProposal(value: unknown, actor: string) {
  const input = requireObject(value);
  const proposalType = requireText(input.proposalType, "proposalType", 80);
  if (!PROPOSAL_TYPES.has(proposalType)) throw new Error("unsupported proposalType");
  const proposalInput = input.input && typeof input.input === "object" && !Array.isArray(input.input)
    ? input.input as Record<string, unknown>
    : {};
  const provider = getAuthoringProposalProvider();
  const proposal = await provider.propose(proposalType, proposalInput);
  const inputHash = stableHash({ proposalType, input: proposalInput });
  const id = objectId("proposal");
  const expiresDays = boundedInteger(input.expiresDays, 30, 1, 365);
  const rows = await queryKnowledge(
    `INSERT INTO knowledge_authoring_proposals
     (id,proposal_type,input_hash,provider,model,input_summary,proposal,status,proposed_by,expires_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'proposed',$8,NOW()+($9::text || ' days')::interval)
     RETURNING *`,
    [
      id,
      proposalType,
      inputHash,
      provider.name,
      provider.model,
      JSON.stringify({ keys: Object.keys(proposalInput).slice(0, 50), inputHash }),
      JSON.stringify(proposal),
      actor,
      expiresDays,
    ],
  );
  return proposalFromRow(rows[0] as Row);
}

export async function listAuthoringProposals(options: { status?: unknown; type?: unknown; limit?: unknown } = {}) {
  const status = typeof options.status === "string" && PROPOSAL_STATUSES.has(options.status) ? options.status : null;
  const type = typeof options.type === "string" && PROPOSAL_TYPES.has(options.type) ? options.type : null;
  const limit = boundedInteger(options.limit, 50, 1, MAX_PROPOSALS);
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (status) { params.push(status); clauses.push(`status=$${params.length}`); }
  if (type) { params.push(type); clauses.push(`proposal_type=$${params.length}`); }
  params.push(limit);
  const rows = await queryKnowledge(
    `SELECT * FROM knowledge_authoring_proposals ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => proposalFromRow(row as Row));
}

export async function decideAuthoringProposal(idValue: unknown, value: unknown, actor: string) {
  const id = assertCanonicalId(idValue, "proposalId");
  const input = requireObject(value);
  const status = requireText(input.status, "status", 40);
  if (!new Set(["accepted", "rejected", "expired"]).has(status)) throw new Error("proposal decision must be accepted, rejected, or expired");
  const mutationIds = Array.isArray(input.acceptedMutationIds)
    ? [...new Set(input.acceptedMutationIds.map((item) => assertCanonicalId(item, "acceptedMutationId")))].slice(0, 100)
    : [];
  if (status !== "accepted" && mutationIds.length) throw new Error("mutation IDs are only valid for accepted proposals");
  const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 10_000) : null;

  return withKnowledgeTransaction(async (client) => {
    const existing = await client.query(`SELECT * FROM knowledge_authoring_proposals WHERE id=$1 FOR UPDATE`, [id]);
    const row = existing.rows[0] as Row | undefined;
    if (!row) return null;
    if (String(row.status) !== "proposed") throw new Error("only proposed authoring assistance can be decided");
    const updated = await client.query(
      `UPDATE knowledge_authoring_proposals SET status=$2,reviewed_by=$3,review_notes=$4,
       accepted_mutation_ids=$5::jsonb,reviewed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, status, actor, notes, JSON.stringify(mutationIds)],
    );
    return proposalFromRow(updated.rows[0] as Row);
  });
}
