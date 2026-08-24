export const NODE_KINDS = [
  "question",
  "claim",
  "claim_family",
  "doctrine",
  "definition",
  "scripture",
  "source",
  "citation",
  "person",
  "tradition",
  "event",
  "objection",
  "response",
  "argument",
  "evidence",
  "conclusion",
] as const;

export type KnowledgeNodeKind = typeof NODE_KINDS[number];

export const RELATIONSHIP_TYPES = [
  "supports",
  "contradicts",
  "responds_to",
  "depends_on",
  "qualifies",
  "quotes",
  "cites",
  "defines",
  "historically_precedes",
  "historically_follows",
  "interprets",
  "disputes_interpretation_of",
  "belongs_to_claim_family",
  "narrower_than",
  "broader_than",
  "equivalent_to",
  "derived_from",
  "addresses_question",
  "teaches_doctrine",
  "used_in_lesson",
  "tested_by_question",
  "connected_to",
] as const;

export type KnowledgeRelationshipType = typeof RELATIONSHIP_TYPES[number];

export const CONTENT_STATES = ["draft", "in_review", "approved", "published", "deprecated", "archived"] as const;
export type KnowledgeContentState = typeof CONTENT_STATES[number];

export const ASSESSMENT_POSITIONS = ["affirms", "rejects", "qualifies", "disputed", "unresolved", "alternative"] as const;
export type AssessmentPosition = typeof ASSESSMENT_POSITIONS[number];

export interface KnowledgeNode {
  id: string;
  kind: KnowledgeNodeKind;
  canonicalSlug: string;
  title: string;
  proposition?: string;
  summary?: string;
  language?: string;
  contentState: KnowledgeContentState;
  currentRevisionId: string | null;
  publishedRevisionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationshipType: KnowledgeRelationshipType;
  contentState: KnowledgeContentState;
  currentRevisionId: string | null;
  publishedRevisionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EdgeAssertion {
  id: string;
  edgeId: string;
  assertedByType: string;
  assertedById: string;
  stance: string;
  sourceIds: string[];
  attributionMode: string;
  confidence: string;
  reviewState: string;
  revisionId: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface KnowledgeAssessment {
  id: string;
  nodeId: string;
  nodeRevisionId: string;
  lens: string;
  position: AssessmentPosition;
  rationaleIds: string[];
  sourceIds: string[];
  reviewState: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSource {
  id: string;
  sourceType: string;
  title: string;
  author?: string;
  edition?: string;
  language?: string;
  authorityClass?: string;
  bindingStatus?: string;
  licensingStatus?: string;
  contentState: KnowledgeContentState;
  currentRevisionId: string | null;
  publishedRevisionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeCitation {
  id: string;
  sourceId: string;
  nodeId?: string;
  nodeRevisionId?: string;
  edgeAssertionId?: string;
  locator: string;
  fragment?: string;
  fragmentMode: string;
  attributionMode: string;
  reviewState: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface NeighborhoodPayload {
  rootNodeId: string;
  depth: number;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  assertions: EdgeAssertion[];
  assessments: KnowledgeAssessment[];
}
