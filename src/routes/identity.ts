import { Router } from "express";
import { createRateLimit } from "../middleware/rateLimit";
import {
  type AccountIdentityAssertionPayload,
  isAccountIdentityConfigured,
  isAccountIdentityEnabled,
  verifyAccountIdentityAssertion,
} from "../security/accountIdentity";
import { signJoinToken } from "../security/joinToken";
import { initializePlayerRoom, resolveAccountPlayer } from "../state/players";
import { flushPersistence } from "../state/persistence";
import { getPlayerRooms, getRoom, isGameplayRoomSupported, joinRoom } from "../state/rooms";

const router = Router();
const MAX_REPLAY_CACHE_ENTRIES = 5_000;

interface IdentityExchangeResponse {
  ok: true;
  identityType: "account";
  userId: string;
  username: string;
  roomId: string;
  rooms: ReturnType<typeof getPlayerRooms>;
  joinToken: string;
  assertionExpiresAt: number;
  identityCreated: boolean;
  displayNameAdjusted: boolean;
  idempotentReplay: boolean;
}

interface ReplayEntry {
  fingerprint: string;
  expiresAt: number;
  response?: IdentityExchangeResponse;
}

const replayCache = new Map<string, ReplayEntry>();
const pendingExchanges = new Map<string, { fingerprint: string; promise: Promise<IdentityExchangeResult> }>();

interface IdentityExchangeFailure {
  ok: false;
  reason: string;
  error: string;
  roomId?: string;
}

interface IdentityExchangeResult {
  status: number;
  body: IdentityExchangeResponse | IdentityExchangeFailure;
}

const identityExchangeRateLimit = createRateLimit({
  name: "IDENTITY_EXCHANGE",
  max: 120,
  windowMs: 10 * 60 * 1000,
  message: "Too many account identity exchanges. Try again later.",
});

function cleanupReplayCache(nowSeconds: number): void {
  for (const [key, entry] of replayCache) {
    if (entry.expiresAt <= nowSeconds) replayCache.delete(key);
  }
  while (replayCache.size >= MAX_REPLAY_CACHE_ENTRIES) {
    const oldestKey = replayCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    replayCache.delete(oldestKey);
  }
}

function verificationStatus(reason: string): number {
  if (reason === "missing" || reason === "malformed" || reason === "invalid_subject" || reason === "invalid_display_name" || reason === "invalid_lifetime") {
    return 400;
  }
  return 401;
}

async function exchangeAccountIdentity(payload: AccountIdentityAssertionPayload): Promise<IdentityExchangeResult> {
  const room = getRoom(payload.roomId);
  if (!room) {
    return { status: 404, body: { ok: false, reason: "room_not_found", error: "Room not found" } };
  }
  if (!isGameplayRoomSupported(room.roomId)) {
    return {
      status: 409,
      body: { ok: false, reason: "room_closed", error: "Room is closed", roomId: room.roomId },
    };
  }

  const resolved = resolveAccountPlayer(payload.issuer, payload.subject, payload.displayName);
  if (!resolved.ok || !resolved.userId || !resolved.username) {
    return {
      status: resolved.reason === "username_taken" ? 409 : 400,
      body: {
        ok: false,
        reason: resolved.reason ?? "identity_resolution_failed",
        error: resolved.message ?? "Unable to create the account-linked player",
      },
    };
  }

  initializePlayerRoom(resolved.userId, room.roomId);
  joinRoom(room.roomId, resolved.userId);
  try {
    if (!(await flushPersistence())) {
      return {
        status: 503,
        body: {
          ok: false,
          reason: "identity_persistence_unavailable",
          error: "Account-linked player identity cannot be saved right now",
        },
      };
    }
  } catch (error) {
    console.error("[Identity] Failed to persist account-linked player identity", error instanceof Error ? error.message : error);
    return {
      status: 503,
      body: {
        ok: false,
        reason: "identity_persistence_failed",
        error: "Account-linked player identity cannot be saved right now",
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      identityType: "account",
      userId: resolved.userId,
      username: resolved.username,
      roomId: room.roomId,
      rooms: getPlayerRooms(resolved.userId),
      joinToken: signJoinToken(room.roomId, resolved.userId, resolved.username),
      assertionExpiresAt: payload.expiresAt,
      identityCreated: resolved.identityCreated === true,
      displayNameAdjusted: resolved.displayNameAdjusted === true,
      idempotentReplay: false,
    },
  };
}

router.post("/exchange", identityExchangeRateLimit, async (req, res) => {
  if (!isAccountIdentityEnabled()) {
    return res.status(503).json({
      ok: false,
      reason: "account_identity_disabled",
      error: "Account-linked player identity is not enabled",
    });
  }
  if (!isAccountIdentityConfigured()) {
    console.error("[Identity] Account exchange is enabled but its server secret or issuer is invalid");
    return res.status(503).json({
      ok: false,
      reason: "account_identity_unavailable",
      error: "Account-linked player identity is unavailable",
    });
  }

  const assertion = typeof req.body?.assertion === "string" ? req.body.assertion : undefined;
  const verification = verifyAccountIdentityAssertion(assertion);
  if (!verification.ok) {
    return res.status(verificationStatus(verification.reason)).json({
      ok: false,
      reason: `identity_assertion_${verification.reason}`,
      error: verification.reason === "expired"
        ? "The account identity assertion expired"
        : "The account identity assertion is invalid",
    });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  cleanupReplayCache(nowSeconds);
  const replayKey = `${verification.payload.issuer}\u0000${verification.payload.nonce}`;
  const replay = replayCache.get(replayKey);
  if (replay) {
    if (replay.fingerprint !== verification.fingerprint) {
      return res.status(409).json({
        ok: false,
        reason: "identity_assertion_nonce_reused",
        error: "The account identity assertion nonce was already used",
      });
    }
    if (replay.response) {
      return res.json({ ...replay.response, idempotentReplay: true });
    }
  }

  const pending = pendingExchanges.get(replayKey);
  if (pending) {
    if (pending.fingerprint !== verification.fingerprint) {
      return res.status(409).json({
        ok: false,
        reason: "identity_assertion_nonce_reused",
        error: "The account identity assertion nonce was already used",
      });
    }
    const result = await pending.promise;
    if (result.body.ok) {
      return res.status(result.status).json({ ...result.body, idempotentReplay: true });
    }
    return res.status(result.status).json(result.body);
  }

  replayCache.set(replayKey, {
    fingerprint: verification.fingerprint,
    expiresAt: verification.payload.expiresAt,
  });
  const promise = exchangeAccountIdentity(verification.payload);
  pendingExchanges.set(replayKey, { fingerprint: verification.fingerprint, promise });
  try {
    const result = await promise;
    if (result.body.ok) {
      replayCache.set(replayKey, {
        fingerprint: verification.fingerprint,
        expiresAt: verification.payload.expiresAt,
        response: result.body,
      });
    }
    return res.status(result.status).json(result.body);
  } finally {
    const current = pendingExchanges.get(replayKey);
    if (current?.promise === promise) pendingExchanges.delete(replayKey);
  }
});

export function resetIdentityExchangeForTests(): void {
  replayCache.clear();
  pendingExchanges.clear();
}

export default router;
