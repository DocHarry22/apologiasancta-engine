import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isValidPublicDisplayName } from "./publicDisplayName";

export interface AccountIdentityAssertionPayload {
  version: 1;
  issuer: string;
  subject: string;
  displayName: string;
  roomId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export type AccountIdentityAssertionVerification =
  | { ok: true; payload: AccountIdentityAssertionPayload; fingerprint: string }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "invalid_signature"
        | "invalid_issuer"
        | "invalid_subject"
        | "invalid_display_name"
        | "invalid_lifetime"
        | "not_yet_valid"
        | "expired";
    };

export type AccountIdentitySecretValidation =
  | { ok: true }
  | { ok: false; reason: "missing" | "placeholder" | "too_short" };

const DEFAULT_ISSUER = "apologia-ui";
const DEFAULT_ASSERTION_TTL_SECONDS = 120;
const MIN_ASSERTION_TTL_SECONDS = 30;
const MAX_ASSERTION_TTL_SECONDS = 300;
const DEFAULT_CLOCK_SKEW_SECONDS = 15;
const MAX_CLOCK_SKEW_SECONDS = 60;
const MIN_SECRET_BYTES = 32;
const ISSUER_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;
const SUBJECT_PATTERN = /^[a-zA-Z0-9:_-]{8,128}$/;
const NONCE_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
const ROOM_ID_PATTERN = /^[a-z0-9-]{3,40}$/;
const BASE64URL_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ASSERTION_PAYLOAD_KEYS = [
  "displayName",
  "expiresAt",
  "issuedAt",
  "issuer",
  "nonce",
  "roomId",
  "subject",
  "version",
] as const;
const PLACEHOLDER_PATTERNS = [
  /^replace-with-/i,
  /^your-(?:secure-)?account-identity-secret$/i,
  /^(?:change-?me|changeme|placeholder)$/i,
  /^apologia-sancta-local-account-identity-secret$/i,
];

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

export function isAccountIdentityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ACCOUNT_IDENTITY_ENABLED?.trim().toLowerCase() === "true";
}

export function getAccountIdentityIssuer(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACCOUNT_IDENTITY_ISSUER?.trim() || DEFAULT_ISSUER;
}

export function getAccountIdentityAssertionTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(
    env.ACCOUNT_IDENTITY_ASSERTION_TTL_SECONDS,
    DEFAULT_ASSERTION_TTL_SECONDS,
    MIN_ASSERTION_TTL_SECONDS,
    MAX_ASSERTION_TTL_SECONDS
  );
}

export function getAccountIdentityClockSkewSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInteger(env.ACCOUNT_IDENTITY_CLOCK_SKEW_SECONDS, DEFAULT_CLOCK_SKEW_SECONDS, 0, MAX_CLOCK_SKEW_SECONDS);
}

export function validateAccountIdentitySecret(value: string | null | undefined): AccountIdentitySecretValidation {
  const configured = value?.trim();
  if (!configured) return { ok: false, reason: "missing" };
  if (isPlaceholderSecret(configured)) return { ok: false, reason: "placeholder" };
  if (Buffer.byteLength(configured, "utf8") < MIN_SECRET_BYTES) return { ok: false, reason: "too_short" };
  return { ok: true };
}

export function isAccountIdentityConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ISSUER_PATTERN.test(getAccountIdentityIssuer(env))
    && validateAccountIdentitySecret(env.ACCOUNT_IDENTITY_SECRET).ok;
}

export function assertAccountIdentityConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (!isAccountIdentityEnabled(env)) return;
  if (!ISSUER_PATTERN.test(getAccountIdentityIssuer(env))) {
    throw new Error("ACCOUNT_IDENTITY_ISSUER must be 3-64 letters, numbers, dots, underscores, or hyphens");
  }
  if (!validateAccountIdentitySecret(env.ACCOUNT_IDENTITY_SECRET).ok) {
    throw new Error("ACCOUNT_IDENTITY_SECRET must contain at least 32 random bytes and must not be a placeholder");
  }
}

function getSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.ACCOUNT_IDENTITY_SECRET?.trim();
  const validation = validateAccountIdentitySecret(secret);
  if (!validation.ok) {
    throw new Error("Account identity assertion signing is not configured");
  }
  return secret!;
}

function signatureFor(encodedPayload: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  return createHmac("sha256", getSecret(env)).update(encodedPayload).digest();
}

function isBasePayload(value: unknown): value is AccountIdentityAssertionPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<AccountIdentityAssertionPayload>;
  const keys = Object.keys(value).sort();
  return keys.length === ASSERTION_PAYLOAD_KEYS.length
    && keys.every((key, index) => key === ASSERTION_PAYLOAD_KEYS[index])
    && payload.version === 1
    && typeof payload.issuer === "string"
    && typeof payload.subject === "string"
    && typeof payload.displayName === "string"
    && typeof payload.roomId === "string"
    && typeof payload.issuedAt === "number"
    && Number.isSafeInteger(payload.issuedAt)
    && typeof payload.expiresAt === "number"
    && Number.isSafeInteger(payload.expiresAt)
    && typeof payload.nonce === "string";
}

/**
 * Test/support signer mirroring the contract implemented by the Next.js server.
 * This function is never exposed over HTTP and the shared secret must never be
 * bundled into browser or Capacitor code.
 */
export function signAccountIdentityAssertion(
  input: { subject: string; displayName: string; roomId?: string; nonce?: string },
  nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload: AccountIdentityAssertionPayload = {
    version: 1,
    issuer: getAccountIdentityIssuer(env),
    subject: input.subject,
    displayName: input.displayName,
    roomId: input.roomId ?? "global",
    issuedAt,
    expiresAt: issuedAt + getAccountIdentityAssertionTtlSeconds(env),
    nonce: input.nonce ?? randomBytes(18).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signatureFor(encodedPayload, env).toString("base64url")}`;
}

export function verifyAccountIdentityAssertion(
  assertion: string | null | undefined,
  nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): AccountIdentityAssertionVerification {
  if (!assertion) return { ok: false, reason: "missing" };
  const parts = assertion.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  if (!BASE64URL_PATTERN.test(parts[0]) || !BASE64URL_PATTERN.test(parts[1])) {
    return { ok: false, reason: "malformed" };
  }

  let receivedSignature: Buffer;
  try {
    receivedSignature = Buffer.from(parts[1], "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  let expectedSignature: Buffer;
  try {
    expectedSignature = signatureFor(parts[0], env);
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
  if (receivedSignature.length !== expectedSignature.length || !timingSafeEqual(receivedSignature, expectedSignature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isBasePayload(payload)) return { ok: false, reason: "malformed" };
  if (payload.issuer !== getAccountIdentityIssuer(env) || !ISSUER_PATTERN.test(payload.issuer)) {
    return { ok: false, reason: "invalid_issuer" };
  }
  if (!SUBJECT_PATTERN.test(payload.subject)) return { ok: false, reason: "invalid_subject" };
  if (!isValidPublicDisplayName(payload.displayName)) return { ok: false, reason: "invalid_display_name" };
  if (!ROOM_ID_PATTERN.test(payload.roomId)) return { ok: false, reason: "malformed" };
  if (!NONCE_PATTERN.test(payload.nonce)) return { ok: false, reason: "malformed" };

  const maximumLifetime = getAccountIdentityAssertionTtlSeconds(env);
  if (payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > maximumLifetime) {
    return { ok: false, reason: "invalid_lifetime" };
  }

  const now = Math.floor(nowMs / 1000);
  const clockSkew = getAccountIdentityClockSkewSeconds(env);
  if (payload.issuedAt > now + clockSkew) return { ok: false, reason: "not_yet_valid" };
  if (payload.expiresAt <= now - clockSkew) return { ok: false, reason: "expired" };

  return {
    ok: true,
    payload,
    fingerprint: createHash("sha256").update(assertion).digest("base64url"),
  };
}
