import { createHash, randomUUID } from "node:crypto";
import {
  ASSESSMENT_POSITIONS,
  CONTENT_STATES,
  NODE_KINDS,
  RELATIONSHIP_TYPES,
  type AssessmentPosition,
  type KnowledgeContentState,
  type KnowledgeNodeKind,
  type KnowledgeRelationshipType,
} from "./types";

const ID_PATTERN = /^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9._:-]*$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export class KnowledgeInputError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeInputError";
  }
}

function invalid(message: string): never {
  throw new KnowledgeInputError(message);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("payload must be an object");
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, maximum: number, required = true): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) invalid(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") invalid(`${field} must be a string`);
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!normalized && required) invalid(`${field} is required`);
  if (normalized.length > maximum) invalid(`${field} exceeds ${maximum} characters`);
  return normalized || undefined;
}

export function asMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return record(value);
}

export function asStringArray(value: unknown, field: string, maximum = 50): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  if (value.length > maximum) invalid(`${field} exceeds ${maximum} entries`);
  return value.map((entry, index) => boundedText(entry, `${field}[${index}]`, 250) as string);
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "untitled";
}

export function canonicalId(kind: string, slug: string): string {
  const normalizedKind = slugify(kind).replace(/-/g, "_");
  const normalizedSlug = slugify(slug);
  return `${normalizedKind}:${normalizedSlug}`;
}

export function assertCanonicalId(value: unknown, field = "id"): string {
  const text = boundedText(value, field, 200) as string;
  if (!ID_PATTERN.test(text)) invalid(`${field} must be a stable canonical id such as claim:john-1-1`);
  return text;
}

export function assertSlug(value: unknown, field = "canonicalSlug"): string {
  const text = boundedText(value, field, 160) as string;
  if (!SLUG_PATTERN.test(text)) invalid(`${field} must contain lowercase letters, numbers, dots, underscores, or hyphens`);
  return text;
}

export function parseNodeKind(value: unknown): KnowledgeNodeKind {
  const text = boundedText(value, "kind", 80) as string;
  if (!(NODE_KINDS as readonly string[]).includes(text)) invalid(`unsupported node kind: ${text}`);
  return text as KnowledgeNodeKind;
}

export function parseRelationshipType(value: unknown): KnowledgeRelationshipType {
  const text = boundedText(value, "relationshipType", 100) as string;
  if (!(RELATIONSHIP_TYPES as readonly string[]).includes(text)) invalid(`unsupported relationship type: ${text}`);
  return text as KnowledgeRelationshipType;
}

export function parseContentState(value: unknown, fallback: KnowledgeContentState = "draft"): KnowledgeContentState {
  if (value === undefined || value === null || value === "") return fallback;
  const text = boundedText(value, "contentState", 40) as string;
  if (!(CONTENT_STATES as readonly string[]).includes(text)) invalid(`unsupported content state: ${text}`);
  return text as KnowledgeContentState;
}

export function parseAssessmentPosition(value: unknown): AssessmentPosition {
  const text = boundedText(value, "position", 40) as string;
  if (!(ASSESSMENT_POSITIONS as readonly string[]).includes(text)) invalid(`unsupported assessment position: ${text}`);
  return text as AssessmentPosition;
}

export interface ValidatedNodeInput {
  id: string;
  kind: KnowledgeNodeKind;
  canonicalSlug: string;
  title: string;
  proposition?: string;
  summary?: string;
  language?: string;
  contentState: KnowledgeContentState;
  metadata: Record<string, unknown>;
  aliases: string[];
}

export function validateNodeInput(value: unknown): ValidatedNodeInput {
  const input = record(value);
  const kind = parseNodeKind(input.kind);
  const title = boundedText(input.title, "title", 500) as string;
  const canonicalSlug = input.canonicalSlug
    ? assertSlug(input.canonicalSlug)
    : slugify(title);
  const id = input.id ? assertCanonicalId(input.id) : canonicalId(kind, canonicalSlug);
  const proposition = boundedText(input.proposition, "proposition", 10_000, false);
  if (["claim", "objection", "response", "conclusion"].includes(kind) && !proposition) {
    invalid(`${kind} nodes require a proposition`);
  }
  const summary = boundedText(input.summary, "summary", 20_000, false);
  const language = boundedText(input.language, "language", 40, false);
  return {
    id,
    kind,
    canonicalSlug,
    title,
    ...(proposition ? { proposition } : {}),
    ...(summary ? { summary } : {}),
    ...(language ? { language } : {}),
    contentState: parseContentState(input.contentState),
    metadata: asMetadata(input.metadata),
    aliases: asStringArray(input.aliases, "aliases", 30),
  };
}

export interface ValidatedEdgeInput {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationshipType: KnowledgeRelationshipType;
  contentState: KnowledgeContentState;
  metadata: Record<string, unknown>;
}

export function validateEdgeInput(value: unknown): ValidatedEdgeInput {
  const input = record(value);
  const fromNodeId = assertCanonicalId(input.fromNodeId, "fromNodeId");
  const toNodeId = assertCanonicalId(input.toNodeId, "toNodeId");
  if (fromNodeId === toNodeId) invalid("an edge cannot connect a node to itself");
  const relationshipType = parseRelationshipType(input.relationshipType);
  const id = input.id
    ? assertCanonicalId(input.id)
    : `edge:${stableHash({ fromNodeId, toNodeId, relationshipType }).slice(0, 24)}`;
  return {
    id,
    fromNodeId,
    toNodeId,
    relationshipType,
    contentState: parseContentState(input.contentState),
    metadata: asMetadata(input.metadata),
  };
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function revisionId(prefix: string): string {
  return `rev:${prefix}:${randomUUID()}`;
}

export function objectId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

export function requireText(value: unknown, field: string, maximum = 500): string {
  return boundedText(value, field, maximum) as string;
}

export function optionalText(value: unknown, field: string, maximum = 500): string | undefined {
  return boundedText(value, field, maximum, false);
}

export function requireObject(value: unknown): Record<string, unknown> {
  return record(value);
}
