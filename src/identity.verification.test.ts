import assert from "node:assert/strict";
import test from "node:test";
import {
  signAccountIdentityAssertion,
  validateAccountIdentitySecret,
  verifyAccountIdentityAssertion,
} from "./security/accountIdentity";
import { verifyJoinToken } from "./security/joinToken";
import { createRoom } from "./state/rooms";
import {
  configurePersistenceForTests,
  createTempStateFilePath,
  resetPersistenceState,
  resetRuntimeState,
  restoreConfiguredPersistence,
  startTestServer,
  withPatchedNow,
} from "./testSupport/runtimeTestUtils";

const TEST_ACCOUNT_SECRET = "identity-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const MANAGED_ENV_KEYS = [
  "ACCOUNT_IDENTITY_ENABLED",
  "ACCOUNT_IDENTITY_SECRET",
  "ACCOUNT_IDENTITY_ISSUER",
  "ACCOUNT_IDENTITY_ASSERTION_TTL_SECONDS",
  "ACCOUNT_IDENTITY_CLOCK_SKEW_SECONDS",
  "PLAYER_JOIN_SECRET",
  "PLAYER_JOIN_TOKEN_TTL_SECONDS",
] as const;
const originalEnvironment = new Map(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));

interface ExchangeSuccess {
  ok: true;
  identityType: "account";
  userId: string;
  username: string;
  roomId: string;
  rooms: Array<{ roomId: string }>;
  joinToken: string;
  assertionExpiresAt: number;
  identityCreated: boolean;
  displayNameAdjusted: boolean;
  idempotentReplay: boolean;
}

async function exchange(baseUrl: string, assertion: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/identity/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assertion }),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

function tamperSignature(value: string): string {
  const [payload, signature] = value.split(".");
  const first = signature[0] === "a" ? "b" : "a";
  return `${payload}.${first}${signature.slice(1)}`;
}

test.beforeEach(async () => {
  await resetPersistenceState();
  resetRuntimeState();
  process.env.ACCOUNT_IDENTITY_ENABLED = "true";
  process.env.ACCOUNT_IDENTITY_SECRET = TEST_ACCOUNT_SECRET;
  process.env.ACCOUNT_IDENTITY_ISSUER = "apologia-ui";
  process.env.ACCOUNT_IDENTITY_ASSERTION_TTL_SECONDS = "120";
  process.env.ACCOUNT_IDENTITY_CLOCK_SKEW_SECONDS = "15";
  process.env.PLAYER_JOIN_SECRET = "join-token-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
  process.env.PLAYER_JOIN_TOKEN_TTL_SECONDS = "300";
});

test.afterEach(async () => {
  await resetPersistenceState();
  resetRuntimeState();
  for (const key of MANAGED_ENV_KEYS) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("account assertions are strict, tamper-evident, short-lived, and backed by a production-grade secret", () => {
  const issuedAtMs = 1_780_000_000_000;
  const env: NodeJS.ProcessEnv = {
    ACCOUNT_IDENTITY_SECRET: TEST_ACCOUNT_SECRET,
    ACCOUNT_IDENTITY_ISSUER: "apologia-ui",
    ACCOUNT_IDENTITY_ASSERTION_TTL_SECONDS: "120",
    ACCOUNT_IDENTITY_CLOCK_SKEW_SECONDS: "15",
  };
  const assertion = signAccountIdentityAssertion({
    subject: "account-00000001",
    displayName: "Athanasius",
    roomId: "alpha-room",
    nonce: "strict-nonce-00000001",
  }, issuedAtMs, env);

  const valid = verifyAccountIdentityAssertion(assertion, issuedAtMs + 1_000, env);
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.payload.subject, "account-00000001");
    assert.equal(valid.payload.roomId, "alpha-room");
  }
  assert.deepEqual(
    verifyAccountIdentityAssertion(tamperSignature(assertion), issuedAtMs + 1_000, env),
    { ok: false, reason: "invalid_signature" }
  );
  assert.deepEqual(
    verifyAccountIdentityAssertion(`${assertion}!`, issuedAtMs + 1_000, env),
    { ok: false, reason: "malformed" }
  );
  assert.deepEqual(
    verifyAccountIdentityAssertion(assertion, issuedAtMs + 136_000, env),
    { ok: false, reason: "expired" }
  );
  assert.deepEqual(validateAccountIdentitySecret("replace-with-account-secret"), { ok: false, reason: "placeholder" });
  assert.deepEqual(validateAccountIdentitySecret("x".repeat(31)), { ok: false, reason: "too_short" });
  assert.deepEqual(validateAccountIdentitySecret("x".repeat(32)), { ok: true });
});

test("account identity stays stable across rooms, fresh sessions, and a persistence restore", async () => {
  const temp = await createTempStateFilePath();
  configurePersistenceForTests(temp.filePath);
  createRoom("Alpha Room", "alpha-room");
  createRoom("Beta Room", "beta-room");
  const server = await startTestServer();
  const subject = "account-00000002";

  try {
    const firstAssertion = signAccountIdentityAssertion({ subject, displayName: "Irenaeus", roomId: "alpha-room" });
    const first = await exchange(server.baseUrl, firstAssertion);
    assert.equal(first.response.status, 200);
    const firstBody = first.body as unknown as ExchangeSuccess;
    assert.equal(firstBody.ok, true);
    assert.match(firstBody.userId, /^acct_[0-9a-f-]{36}$/);
    assert.equal(firstBody.identityCreated, true);
    assert.equal(firstBody.idempotentReplay, false);
    assert.equal(JSON.stringify(firstBody).includes(subject), false);

    const exactRetry = await exchange(server.baseUrl, firstAssertion);
    assert.equal(exactRetry.response.status, 200);
    const retryBody = exactRetry.body as unknown as ExchangeSuccess;
    assert.equal(retryBody.userId, firstBody.userId);
    assert.equal(retryBody.joinToken, firstBody.joinToken);
    assert.equal(retryBody.idempotentReplay, true);

    const secondAssertion = signAccountIdentityAssertion({ subject, displayName: "Irenaeus", roomId: "beta-room" });
    const second = await exchange(server.baseUrl, secondAssertion);
    assert.equal(second.response.status, 200);
    const secondBody = second.body as unknown as ExchangeSuccess;
    assert.equal(secondBody.userId, firstBody.userId);
    assert.equal(secondBody.identityCreated, false);
    assert.deepEqual(secondBody.rooms.map((room) => room.roomId).sort(), ["alpha-room", "beta-room"]);
    const secondToken = verifyJoinToken(secondBody.joinToken);
    assert.equal(secondToken.ok, true);
    if (secondToken.ok) {
      assert.equal(secondToken.payload.userId, firstBody.userId);
      assert.equal(secondToken.payload.roomId, "beta-room");
    }

    resetRuntimeState();
    assert.equal(await restoreConfiguredPersistence(), true);
    const restoredAssertion = signAccountIdentityAssertion({ subject, displayName: "Irenaeus", roomId: "alpha-room" });
    const restored = await exchange(server.baseUrl, restoredAssertion);
    assert.equal(restored.response.status, 200);
    const restoredBody = restored.body as unknown as ExchangeSuccess;
    assert.equal(restoredBody.userId, firstBody.userId);
    assert.equal(restoredBody.identityCreated, false);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("identity exchange rejects expired, unsafe, and nonce-conflicting assertions and deduplicates concurrent retries", async () => {
  const temp = await createTempStateFilePath();
  configurePersistenceForTests(temp.filePath);
  const server = await startTestServer();

  try {
    const valid = signAccountIdentityAssertion({
      subject: "account-00000003",
      displayName: "Augustine",
      nonce: "concurrent-nonce-000001",
    });
    const tampered = await exchange(server.baseUrl, tamperSignature(valid));
    assert.equal(tampered.response.status, 401);
    assert.equal(tampered.body.reason, "identity_assertion_invalid_signature");

    const expired = signAccountIdentityAssertion(
      { subject: "account-00000004", displayName: "Jerome" },
      Date.now() - 180_000
    );
    const expiredResult = await exchange(server.baseUrl, expired);
    assert.equal(expiredResult.response.status, 401);
    assert.equal(expiredResult.body.reason, "identity_assertion_expired");

    const unsafe = signAccountIdentityAssertion({
      subject: "account-00000005",
      displayName: "unsafe name!",
    });
    const unsafeResult = await exchange(server.baseUrl, unsafe);
    assert.equal(unsafeResult.response.status, 400);
    assert.equal(unsafeResult.body.reason, "identity_assertion_invalid_display_name");

    const [concurrentA, concurrentB] = await Promise.all([
      exchange(server.baseUrl, valid),
      exchange(server.baseUrl, valid),
    ]);
    assert.equal(concurrentA.response.status, 200);
    assert.equal(concurrentB.response.status, 200);
    const concurrentBodies = [concurrentA.body, concurrentB.body] as unknown as ExchangeSuccess[];
    assert.equal(concurrentBodies[0].userId, concurrentBodies[1].userId);
    assert.equal(concurrentBodies[0].joinToken, concurrentBodies[1].joinToken);
    assert.deepEqual(concurrentBodies.map((body) => body.idempotentReplay).sort(), [false, true]);

    const nonceConflict = signAccountIdentityAssertion({
      subject: "account-00000003",
      displayName: "Different_Name",
      nonce: "concurrent-nonce-000001",
    });
    const conflict = await exchange(server.baseUrl, nonceConflict);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.reason, "identity_assertion_nonce_reused");

    const graceBoundary = 1_780_100_000_000;
    const graceNonce = "clock-skew-nonce-000001";
    const expiringAssertion = signAccountIdentityAssertion({
      subject: "account-00000006",
      displayName: "Origen",
      nonce: graceNonce,
    }, graceBoundary - 120_000);
    const acceptedInGrace = await withPatchedNow(
      graceBoundary,
      () => exchange(server.baseUrl, expiringAssertion)
    );
    assert.equal(acceptedInGrace.response.status, 200);

    const conflictingDuringGrace = signAccountIdentityAssertion({
      subject: "account-00000006",
      displayName: "Origen_Changed",
      nonce: graceNonce,
    }, graceBoundary + 5_000);
    const graceConflict = await withPatchedNow(
      graceBoundary + 5_000,
      () => exchange(server.baseUrl, conflictingDuringGrace)
    );
    assert.equal(graceConflict.response.status, 409);
    assert.equal(graceConflict.body.reason, "identity_assertion_nonce_reused");
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("guest registration and room joining remain compatible while expired tokens can only refresh the same identity", async () => {
  createRoom("Guest Room", "guest-room");
  const server = await startTestServer();

  try {
    const registration = await fetch(`${server.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "Guest_One" }),
    });
    assert.equal(registration.status, 200);
    const guest = await registration.json() as { userId: string; username: string; joinToken: string };

    const join = await fetch(`${server.baseUrl}/rooms/guest-room/join`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${guest.joinToken}` },
      body: JSON.stringify({ userId: guest.userId }),
    });
    assert.equal(join.status, 200);

    const tamperedJoin = await fetch(`${server.baseUrl}/rooms/guest-room/join`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tamperSignature(guest.joinToken)}` },
      body: JSON.stringify({ userId: guest.userId }),
    });
    assert.equal(tamperedJoin.status, 401);

    const token = verifyJoinToken(guest.joinToken);
    assert.equal(token.ok, true);
    if (!token.ok) throw new Error("Expected the guest join token to be valid before expiry");

    await withPatchedNow(token.payload.expiresAt * 1000, async () => {
      const expiredMe = await fetch(`${server.baseUrl}/register/me?roomId=guest-room&userId=${guest.userId}`, {
        headers: { authorization: `Bearer ${guest.joinToken}` },
      });
      assert.equal(expiredMe.status, 401);
      assert.equal((await expiredMe.json() as { reason: string }).reason, "join_token_expired");

      const expiredRename = await fetch(`${server.baseUrl}/register/rename`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${guest.joinToken}` },
        body: JSON.stringify({ userId: guest.userId, newUsername: "Guest_Two", roomId: "guest-room" }),
      });
      assert.equal(expiredRename.status, 401);

      const changedIdentity = await fetch(`${server.baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${guest.joinToken}` },
        body: JSON.stringify({ userId: guest.userId, username: "Guest_Two", roomId: "guest-room" }),
      });
      assert.equal(changedIdentity.status, 401);

      const refreshedJoin = await fetch(`${server.baseUrl}/rooms/guest-room/join`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${guest.joinToken}` },
        body: JSON.stringify({ userId: guest.userId }),
      });
      assert.equal(refreshedJoin.status, 200);
      const refreshedJoinBody = await refreshedJoin.json() as { joinToken: string; username: string };
      assert.equal(refreshedJoinBody.username, guest.username);
      assert.equal(verifyJoinToken(refreshedJoinBody.joinToken).ok, true);

      const refreshedRegistration = await fetch(`${server.baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${guest.joinToken}` },
        body: JSON.stringify({ userId: guest.userId, username: guest.username, roomId: "guest-room" }),
      });
      assert.equal(refreshedRegistration.status, 200);
      assert.equal(verifyJoinToken((await refreshedRegistration.json() as { joinToken: string }).joinToken).ok, true);
    });
  } finally {
    await server.close();
  }
});
