import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface JoinTokenPayload {
  version: 1;
  roomId: string;
  userId: string;
  displayName: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export type JoinTokenVerification =
  | { ok: true; payload: JoinTokenPayload }
  | { ok: false; reason: "expired"; payload: JoinTokenPayload }
  | { ok: false; reason: "missing" | "malformed" | "invalid_signature" | "not_yet_valid" };

const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEVELOPMENT_SECRET = "apologia-sancta-local-join-token-secret";

function getSecret(): string {
  const configured = process.env.PLAYER_JOIN_SECRET?.trim();
  if (configured && configured !== "replace-with-join-secret") return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("PLAYER_JOIN_SECRET is required in production");
  }
  return DEVELOPMENT_SECRET;
}

function getTtlSeconds(): number {
  const value = Number(process.env.PLAYER_JOIN_TOKEN_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(value)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(value)));
}

function signatureFor(encodedPayload: string): Buffer {
  return createHmac("sha256", getSecret()).update(encodedPayload).digest();
}

function isJoinTokenPayload(value: unknown): value is JoinTokenPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<JoinTokenPayload>;
  return payload.version === 1
    && typeof payload.roomId === "string"
    && payload.roomId.length >= 3
    && payload.roomId.length <= 40
    && typeof payload.userId === "string"
    && payload.userId.length > 0
    && payload.userId.length <= 200
    && typeof payload.displayName === "string"
    && payload.displayName.length > 0
    && payload.displayName.length <= 20
    && typeof payload.issuedAt === "number"
    && Number.isFinite(payload.issuedAt)
    && typeof payload.expiresAt === "number"
    && Number.isFinite(payload.expiresAt)
    && typeof payload.nonce === "string"
    && payload.nonce.length >= 8;
}

export function isJoinTokenConfigured(): boolean {
  const configured = process.env.PLAYER_JOIN_SECRET?.trim();
  return Boolean(configured && configured !== "replace-with-join-secret");
}

export function signJoinToken(roomId: string, userId: string, displayName: string, nowMs = Date.now()): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload: JoinTokenPayload = {
    version: 1,
    roomId,
    userId,
    displayName,
    issuedAt,
    expiresAt: issuedAt + getTtlSeconds(),
    nonce: randomBytes(9).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signatureFor(encodedPayload).toString("base64url")}`;
}

export function verifyJoinToken(token: string | null | undefined, nowMs = Date.now()): JoinTokenVerification {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };

  let receivedSignature: Buffer;
  try {
    receivedSignature = Buffer.from(parts[1], "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expectedSignature = signatureFor(parts[0]);
  if (receivedSignature.length !== expectedSignature.length || !timingSafeEqual(receivedSignature, expectedSignature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isJoinTokenPayload(payload)) return { ok: false, reason: "malformed" };

  const now = Math.floor(nowMs / 1000);
  if (payload.issuedAt > now + 30) return { ok: false, reason: "not_yet_valid" };
  if (payload.expiresAt <= now) return { ok: false, reason: "expired", payload };
  return { ok: true, payload };
}
