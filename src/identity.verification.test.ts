import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAccountIdentityConfiguration,
  isAccountIdentityConfigured,
  signAccountIdentityAssertion,
  validateAccountIdentitySecret,
  verifyAccountIdentityAssertion,
} from "./security/accountIdentity";
import { verifyJoinToken } from "./security/joinToken";
import {
  getAccountIdentityMapping,
  getPlayer,
  getPlayersPersistenceSnapshot,
  initializePlayerRoom,
  isUsernameTaken,
  registerPlayer,
} from "./state/players";
import {
  createRoom,
  getRoomsPersistenceSnapshot,
  isPlayerInRoom,
  joinRoom,
} from "./state/rooms";
import {
  flushPersistence,
  setPostgresPoolFactoryForTests,
  setStatePersistenceDatabaseUrlForTests,
} from "./state/persistence";
import {
  DEFAULT_IDENTITY_EXCHANGE_RATE_LIMIT_MAX,
  DEFAULT_IDENTITY_EXCHANGE_RATE_LIMIT_WINDOW_MS,
} from "./routes/identity";
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

function assertNoIdentityArtifacts(subject: string, displayName: string): void {
  const playersSnapshot = getPlayersPersistenceSnapshot();
  const roomsSnapshot = getRoomsPersistenceSnapshot();
  assert.equal(getAccountIdentityMapping("apologia-ui", subject), undefined);
  assert.equal(isUsernameTaken(displayName), false);
  assert.equal(playersSnapshot.players.some((player) => player.username === displayName), false);
  assert.equal(playersSnapshot.accountIdentities?.some((mapping) => mapping.subject === subject) ?? false, false);
  assert.equal(
    playersSnapshot.roomStates.some((room) => room.playerStates.some((state) => state.userId.startsWith("acct_"))),
    false
  );
  assert.equal(roomsSnapshot.memberships.some((membership) => membership.userId.startsWith("acct_")), false);
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
  assert.equal(DEFAULT_IDENTITY_EXCHANGE_RATE_LIMIT_MAX, 6_000);
  assert.equal(DEFAULT_IDENTITY_EXCHANGE_RATE_LIMIT_WINDOW_MS, 600_000);
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
  assert.deepEqual(validateAccountIdentitySecret("apologia-sancta-local-join-token-secret"), { ok: false, reason: "placeholder" });
  assert.deepEqual(validateAccountIdentitySecret("x".repeat(31)), { ok: false, reason: "too_short" });
  assert.deepEqual(validateAccountIdentitySecret("x".repeat(32)), { ok: true });
});

test("account identity and room join secrets must remain separate at startup and runtime", async () => {
  const reusedSecret = "shared-secret-that-must-not-cross-trust-boundaries-0123456789";
  const reusedEnvironment: NodeJS.ProcessEnv = {
    ACCOUNT_IDENTITY_ENABLED: "true",
    ACCOUNT_IDENTITY_SECRET: ` ${reusedSecret} `,
    ACCOUNT_IDENTITY_ISSUER: "apologia-ui",
    PLAYER_JOIN_SECRET: reusedSecret,
  };

  assert.deepEqual(
    validateAccountIdentitySecret(reusedEnvironment.ACCOUNT_IDENTITY_SECRET, reusedEnvironment.PLAYER_JOIN_SECRET),
    { ok: false, reason: "matches_player_join_secret" }
  );
  assert.equal(isAccountIdentityConfigured(reusedEnvironment), false);
  assert.throws(
    () => assertAccountIdentityConfiguration(reusedEnvironment),
    /ACCOUNT_IDENTITY_SECRET must be different from PLAYER_JOIN_SECRET/
  );
  assert.doesNotThrow(() => assertAccountIdentityConfiguration({
    ...reusedEnvironment,
    ACCOUNT_IDENTITY_ENABLED: "false",
  }));
  assert.throws(
    () => signAccountIdentityAssertion({ subject: "account-00000007", displayName: "Cyprian" }, Date.now(), reusedEnvironment),
    /Account identity assertion signing is not configured/
  );

  process.env.ACCOUNT_IDENTITY_SECRET = process.env.PLAYER_JOIN_SECRET;
  process.env.ACCOUNT_IDENTITY_ENABLED = "false";
  const server = await startTestServer();
  try {
    const disabledDiagnostics = await fetch(`${server.baseUrl}/diagnostics`).then((response) => response.json()) as {
      readiness: { accountIdentityExchange: boolean };
      features: { accountIdentityExchange: boolean };
    };
    assert.equal(disabledDiagnostics.features.accountIdentityExchange, false);
    assert.equal(disabledDiagnostics.readiness.accountIdentityExchange, true);
    const disabled = await exchange(server.baseUrl, "not-a-valid-assertion");
    assert.equal(disabled.response.status, 503);
    assert.equal(disabled.body.reason, "account_identity_disabled");

    process.env.ACCOUNT_IDENTITY_ENABLED = "true";
    const diagnosticsResponse = await fetch(`${server.baseUrl}/diagnostics`);
    assert.equal(diagnosticsResponse.status, 200);
    const diagnosticsText = await diagnosticsResponse.text();
    assert.equal(diagnosticsText.includes(process.env.ACCOUNT_IDENTITY_SECRET!), false);
    const diagnostics = JSON.parse(diagnosticsText) as {
      readiness: { accountIdentityExchange: boolean };
      features: { accountIdentityExchange: boolean };
    };
    assert.equal(diagnostics.features.accountIdentityExchange, true);
    assert.equal(diagnostics.readiness.accountIdentityExchange, false);

    const unavailable = await exchange(server.baseUrl, "not-a-valid-assertion");
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.reason, "account_identity_unavailable");
  } finally {
    await server.close();
  }
});

test("identity exchange applies no state without persistence and a later retry succeeds cleanly", async () => {
  const subject = "account-no-persistence";
  const displayName = "Ambrose";
  const room = createRoom("Atomic Room", "atomic-room");
  const assertion = signAccountIdentityAssertion({
    subject,
    displayName,
    roomId: room.roomId,
    nonce: "no-persistence-nonce-01",
  });
  const temp = await createTempStateFilePath();
  const server = await startTestServer();

  try {
    const unavailable = await exchange(server.baseUrl, assertion);
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.reason, "identity_persistence_unavailable");
    assertNoIdentityArtifacts(subject, displayName);

    configurePersistenceForTests(temp.filePath);
    const retry = await exchange(server.baseUrl, assertion);
    assert.equal(retry.response.status, 200);
    const retryBody = retry.body as unknown as ExchangeSuccess;
    assert.equal(retryBody.identityCreated, true);
    assert.equal(retryBody.username, displayName);
    assert.equal(getAccountIdentityMapping("apologia-ui", subject)?.userId, retryBody.userId);
    assert.equal(isPlayerInRoom(room.roomId, retryBody.userId), true);
  } finally {
    await server.close();
    await resetPersistenceState();
    await temp.cleanup();
  }
});

test("a rejected persistence write rolls back only identity state and the assertion can retry", async () => {
  const subject = "account-write-failure";
  const displayName = "Basil";
  const room = createRoom("Rollback Room", "rollback-room");
  const assertion = signAccountIdentityAssertion({
    subject,
    displayName,
    roomId: room.roomId,
    nonce: "write-failure-nonce-01",
  });
  let releaseFailedWrite!: () => void;
  let reportWriteStarted!: () => void;
  const failedWriteGate = new Promise<void>((resolve) => { releaseFailedWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { reportWriteStarted = resolve; });
  let rejectNextWrite = true;

  setStatePersistenceDatabaseUrlForTests("postgresql://test:test@localhost/identity_rollback");
  setPostgresPoolFactoryForTests(async () => ({
    query: async (sql) => {
      if (sql.includes("INSERT INTO runtime_state_snapshots") && rejectNextWrite) {
        rejectNextWrite = false;
        reportWriteStarted();
        await failedWriteGate;
        throw new Error("simulated identity persistence failure");
      }
      return { rows: [] };
    },
    end: async () => undefined,
  }));
  configurePersistenceForTests("", "postgres");
  const server = await startTestServer();

  try {
    const failedExchange = exchange(server.baseUrl, assertion);
    await writeStarted;

    const unrelated = registerPlayer("Unrelated_Player", "unrelated-player");
    assert.equal(unrelated.ok, true);
    initializePlayerRoom("unrelated-player", room.roomId);
    joinRoom(room.roomId, "unrelated-player");
    releaseFailedWrite();

    const failed = await failedExchange;
    assert.equal(failed.response.status, 503);
    assert.equal(failed.body.reason, "identity_persistence_failed");
    assertNoIdentityArtifacts(subject, displayName);
    assert.equal(isUsernameTaken("Unrelated_Player"), true);
    assert.equal(isPlayerInRoom(room.roomId, "unrelated-player"), true);

    const retry = await exchange(server.baseUrl, assertion);
    assert.equal(retry.response.status, 200);
    const retryBody = retry.body as unknown as ExchangeSuccess;
    assert.equal(retryBody.identityCreated, true);
    assert.equal(getAccountIdentityMapping("apologia-ui", subject)?.userId, retryBody.userId);
    assert.equal(isPlayerInRoom(room.roomId, retryBody.userId), true);
    assert.equal(isPlayerInRoom(room.roomId, "unrelated-player"), true);
  } finally {
    releaseFailedWrite();
    await server.close();
  }
});

test("account rename reserves the old display name until persistence commits or rolls back", async () => {
  const subject = "account-rename-reservation";
  const oldDisplayName = "Reserved_Old_Name";
  const newDisplayName = "Committed_New_Name";
  const originalRoom = createRoom("Rename Origin", "rename-origin");
  const targetRoom = createRoom("Rename Target", "rename-target");
  let releaseFailedWrite!: () => void;
  let reportWriteStarted!: () => void;
  const failedWriteGate = new Promise<void>((resolve) => { releaseFailedWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { reportWriteStarted = resolve; });
  let releaseSuccessfulWrite!: () => void;
  let reportSuccessfulWriteStarted!: () => void;
  const successfulWriteGate = new Promise<void>((resolve) => { releaseSuccessfulWrite = resolve; });
  const successfulWriteStarted = new Promise<void>((resolve) => { reportSuccessfulWriteStarted = resolve; });
  let rejectRenamedSnapshot = true;
  let delaySuccessfulRenamedSnapshot = true;
  const successfulPlayerSnapshots: string[][] = [];

  setStatePersistenceDatabaseUrlForTests("postgresql://test:test@localhost/identity_rename_reservation");
  setPostgresPoolFactoryForTests(async () => ({
    query: async (sql, values) => {
      if (sql.includes("INSERT INTO runtime_state_snapshots")) {
        const snapshot = JSON.parse(String(values?.[2])) as {
          players?: { players?: Array<{ username?: string }> };
        };
        const displayNames = snapshot.players?.players?.flatMap(
          (player) => player.username ? [player.username] : []
        ) ?? [];
        if (rejectRenamedSnapshot && displayNames.includes(newDisplayName)) {
          rejectRenamedSnapshot = false;
          reportWriteStarted();
          await failedWriteGate;
          throw new Error("simulated account rename persistence failure");
        }
        if (delaySuccessfulRenamedSnapshot && displayNames.includes(newDisplayName)) {
          delaySuccessfulRenamedSnapshot = false;
          reportSuccessfulWriteStarted();
          await successfulWriteGate;
        }
        successfulPlayerSnapshots.push(displayNames);
      }
      return { rows: [] };
    },
    end: async () => undefined,
  }));
  configurePersistenceForTests("", "postgres");
  const server = await startTestServer();

  try {
    const initialAssertion = signAccountIdentityAssertion({
      subject,
      displayName: oldDisplayName,
      roomId: originalRoom.roomId,
      nonce: "rename-reservation-initial",
    });
    const initial = await exchange(server.baseUrl, initialAssertion);
    assert.equal(initial.response.status, 200);
    const initialBody = initial.body as unknown as ExchangeSuccess;
    assert.equal(initialBody.username, oldDisplayName);

    const renameAssertion = signAccountIdentityAssertion({
      subject,
      displayName: newDisplayName,
      roomId: targetRoom.roomId,
      nonce: "rename-reservation-retry",
    });
    const failedRename = exchange(server.baseUrl, renameAssertion);
    await writeStarted;

    const guestAttempt = await fetch(`${server.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: oldDisplayName, roomId: originalRoom.roomId }),
    });
    assert.equal(guestAttempt.status, 409);
    assert.equal((await guestAttempt.json() as { reason: string }).reason, "username_taken");

    releaseFailedWrite();
    const failed = await failedRename;
    assert.equal(failed.response.status, 503);
    assert.equal(failed.body.reason, "identity_persistence_failed");
    assert.equal(getAccountIdentityMapping("apologia-ui", subject)?.userId, initialBody.userId);
    assert.equal(getPlayer(initialBody.userId)?.username, oldDisplayName);
    assert.equal(isUsernameTaken(oldDisplayName), true);
    assert.equal(isUsernameTaken(newDisplayName), false);
    assert.equal(isPlayerInRoom(originalRoom.roomId, initialBody.userId), true);
    assert.equal(isPlayerInRoom(targetRoom.roomId, initialBody.userId), false);
    await flushPersistence();
    const postRollbackSnapshot = successfulPlayerSnapshots.at(-1) ?? [];
    assert.equal(postRollbackSnapshot.includes(oldDisplayName), true);
    assert.equal(postRollbackSnapshot.includes(newDisplayName), false);

    const retryRequest = exchange(server.baseUrl, renameAssertion);
    await successfulWriteStarted;
    const guestDuringSuccessfulWrite = await fetch(`${server.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: oldDisplayName, roomId: originalRoom.roomId }),
    });
    assert.equal(guestDuringSuccessfulWrite.status, 409);
    assert.equal((await guestDuringSuccessfulWrite.json() as { reason: string }).reason, "username_taken");

    releaseSuccessfulWrite();
    const retry = await retryRequest;
    assert.equal(retry.response.status, 200);
    const retryBody = retry.body as unknown as ExchangeSuccess;
    assert.equal(retryBody.userId, initialBody.userId);
    assert.equal(retryBody.username, newDisplayName);
    assert.equal(retryBody.identityCreated, false);
    assert.equal(getPlayer(initialBody.userId)?.username, newDisplayName);
    assert.equal(isPlayerInRoom(originalRoom.roomId, initialBody.userId), true);
    assert.equal(isPlayerInRoom(targetRoom.roomId, initialBody.userId), true);
    assert.equal(isUsernameTaken(oldDisplayName), false);
    assert.equal(isUsernameTaken(newDisplayName), true);

    const guestRegistration = await fetch(`${server.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: oldDisplayName, roomId: originalRoom.roomId }),
    });
    assert.equal(guestRegistration.status, 200);
    const guestBody = await guestRegistration.json() as { userId: string; username: string };
    assert.notEqual(guestBody.userId, initialBody.userId);
    assert.equal(guestBody.username, oldDisplayName);
    assert.equal(getPlayer(initialBody.userId)?.username, newDisplayName);
    assert.equal(getPlayer(guestBody.userId)?.username, oldDisplayName);
  } finally {
    releaseFailedWrite();
    releaseSuccessfulWrite();
    await server.close();
  }
});

test("distinct concurrent assertions for one account resolve to one player across rooms", async () => {
  const temp = await createTempStateFilePath();
  const alpha = createRoom("Concurrent Alpha", "concurrent-alpha");
  const beta = createRoom("Concurrent Beta", "concurrent-beta");
  configurePersistenceForTests(temp.filePath);
  const subject = "account-concurrent-stable";
  const alphaAssertion = signAccountIdentityAssertion({
    subject,
    displayName: "Chrysostom",
    roomId: alpha.roomId,
    nonce: "concurrent-subject-alpha",
  });
  const betaAssertion = signAccountIdentityAssertion({
    subject,
    displayName: "Chrysostom",
    roomId: beta.roomId,
    nonce: "concurrent-subject-beta-1",
  });
  const server = await startTestServer();

  try {
    const [alphaResult, betaResult] = await Promise.all([
      exchange(server.baseUrl, alphaAssertion),
      exchange(server.baseUrl, betaAssertion),
    ]);
    assert.equal(alphaResult.response.status, 200);
    assert.equal(betaResult.response.status, 200);
    const alphaBody = alphaResult.body as unknown as ExchangeSuccess;
    const betaBody = betaResult.body as unknown as ExchangeSuccess;
    assert.equal(alphaBody.userId, betaBody.userId);
    assert.deepEqual([alphaBody.identityCreated, betaBody.identityCreated].sort(), [false, true]);
    assert.equal(isPlayerInRoom(alpha.roomId, alphaBody.userId), true);
    assert.equal(isPlayerInRoom(beta.roomId, alphaBody.userId), true);
    assert.equal(getPlayersPersistenceSnapshot().players.filter((player) => player.userId === alphaBody.userId).length, 1);
  } finally {
    await server.close();
    await resetPersistenceState();
    await temp.cleanup();
  }
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

      await withPatchedNow(secondToken.payload.expiresAt * 1000, async () => {
        const expiredJoin = await fetch(`${server.baseUrl}/rooms/beta-room/join`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${secondBody.joinToken}` },
          body: JSON.stringify({ userId: firstBody.userId }),
        });
        assert.equal(expiredJoin.status, 401);
        assert.equal((await expiredJoin.json() as { reason: string }).reason, "join_token_expired");

        const expiredRegistration = await fetch(`${server.baseUrl}/register`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${secondBody.joinToken}` },
          body: JSON.stringify({
            userId: firstBody.userId,
            username: secondBody.username,
            roomId: "beta-room",
          }),
        });
        assert.equal(expiredRegistration.status, 401);
        assert.equal((await expiredRegistration.json() as { reason: string }).reason, "join_token_expired");

        const freshAssertion = signAccountIdentityAssertion({
          subject,
          displayName: "Irenaeus",
          roomId: "beta-room",
        });
        const refreshed = await exchange(server.baseUrl, freshAssertion);
        assert.equal(refreshed.response.status, 200);
        const refreshedBody = refreshed.body as unknown as ExchangeSuccess;
        assert.equal(refreshedBody.userId, firstBody.userId);
        assert.equal(refreshedBody.identityCreated, false);
        assert.equal(verifyJoinToken(refreshedBody.joinToken).ok, true);
      });
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
