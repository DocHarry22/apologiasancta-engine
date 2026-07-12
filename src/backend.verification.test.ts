import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, rm } from "node:fs/promises";
import { ingestQuestions } from "./content/bank";
import { start, pause, skipToNext, startNextTopic, getStatus, getAnswerWindowStatus } from "./engine/roundController";
import {
  evaluateAnswers,
  getLeaderboardForPeriod,
  getPlayerInfo,
  initializePlayerRoom,
  registerPlayer,
  submitAnswerForRegistered,
} from "./state/players";
import { createRoom, getRoom, joinRoom } from "./state/rooms";
import {
  configurePersistenceForTests,
  createTempStateDbPath,
  createTempStateFilePath,
  resetPersistenceState,
  resetRuntimeState,
  restoreConfiguredPersistence,
  startTestServer,
  withPatchedNow,
} from "./testSupport/runtimeTestUtils";

const ADMIN_HEADERS = {
  "content-type": "application/json",
  "x-admin-token": "dev-admin-token",
};

function buildQuestion(id: string, topicId: string, text: string) {
  return {
    id,
    topicId,
    question: text,
    choices: {
      A: "Alpha",
      B: "Beta",
      C: "Gamma",
      D: "Delta",
    },
    correctId: "A" as const,
    teaching: {
      title: `Theme ${topicId}`,
      body: `Teaching for ${id}`,
    },
    difficulty: 3 as const,
  };
}

async function scoreCorrectAnswerAt(nowMs: number, roomId: string, userId: string, questionIndex = 0) {
  await withPatchedNow(nowMs, async () => {
    const answerResult = submitAnswerForRegistered(questionIndex, userId, "a", roomId);
    assert.equal(answerResult.accepted, true);
    evaluateAnswers(
      questionIndex,
      "a",
      {
        openStartMs: nowMs - 1000,
        openDurationMs: 25000,
        difficulty: 3,
      },
      roomId
    );
  });
}

test.beforeEach(() => {
  resetRuntimeState();
});

test.afterEach(async () => {
  await resetPersistenceState();
});

test("leaderboard windows stay room-scoped and weekly resets on Sunday midnight", async () => {
  const alpha = createRoom("Alpha Chapel", "alpha");
  const beta = createRoom("Beta Chapel", "beta");

  const alice = registerPlayer("Alice", "alice-id");
  const bob = registerPlayer("Bob", "bob-id");
  const carol = registerPlayer("Carol", "carol-id");

  assert.equal(alice.ok, true);
  assert.equal(bob.ok, true);
  assert.equal(carol.ok, true);

  initializePlayerRoom(alice.userId!, alpha.roomId);
  initializePlayerRoom(bob.userId!, alpha.roomId);
  initializePlayerRoom(carol.userId!, beta.roomId);
  joinRoom(alpha.roomId, alice.userId!);
  joinRoom(alpha.roomId, bob.userId!);
  joinRoom(beta.roomId, carol.userId!);

  await scoreCorrectAnswerAt(new Date("2026-03-21T23:59:59").getTime(), alpha.roomId, alice.userId!, 0);
  await scoreCorrectAnswerAt(new Date("2026-03-22T00:00:01").getTime(), alpha.roomId, bob.userId!, 1);
  await scoreCorrectAnswerAt(new Date("2026-03-23T09:00:00").getTime(), alpha.roomId, alice.userId!, 2);
  await scoreCorrectAnswerAt(new Date("2026-03-23T10:00:00").getTime(), beta.roomId, carol.userId!, 0);

  await withPatchedNow(new Date("2026-03-23T12:00:00").getTime(), async () => {
    const alphaDaily = getLeaderboardForPeriod("daily", { roomId: alpha.roomId });
    assert.deepEqual(alphaDaily.topScorers.map((entry) => entry.name), ["Alice"]);

    const alphaWeekly = getLeaderboardForPeriod("weekly", { roomId: alpha.roomId });
    assert.deepEqual(alphaWeekly.topScorers.map((entry) => entry.name), ["Alice", "Bob"]);

    const alphaAllTime = getLeaderboardForPeriod("all-time", { roomId: alpha.roomId });
    assert.deepEqual(alphaAllTime.topScorers.map((entry) => entry.name), ["Alice", "Bob"]);

    const globalDaily = getLeaderboardForPeriod("daily");
    assert.deepEqual(globalDaily.topScorers.map((entry) => entry.name), ["Alice", "Carol"]);

    const betaInfo = getPlayerInfo(carol.userId!, beta.roomId);
    assert.equal(betaInfo?.roomId, beta.roomId);
    assert.equal(betaInfo?.username, "Carol");
    assert.equal(betaInfo?.totalPoints! > 0, true);
  });
});

test("admin and health endpoints expose persistence state and closed rooms block gameplay", async () => {
  const temp = await createTempStateFilePath();
  configurePersistenceForTests(temp.filePath);

  const server = await startTestServer();
  try {
    const registerResponse = await fetch(`${server.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "Alice" }),
    });
    assert.equal(registerResponse.status, 200);
    const registered = await registerResponse.json() as { userId: string };

    const roomResponse = await fetch(`${server.baseUrl}/admin/rooms`, {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ name: "Alpha Room", roomId: "alpha-room" }),
    });
    assert.equal(roomResponse.status, 201);

    const joinResponse = await fetch(`${server.baseUrl}/rooms/alpha-room/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: registered.userId }),
    });
    assert.equal(joinResponse.status, 200);

    const saveResponse = await fetch(`${server.baseUrl}/admin/persistence/save`, {
      method: "POST",
      headers: ADMIN_HEADERS,
    });
    assert.equal(saveResponse.status, 200);
    const savePayload = await saveResponse.json() as { success: boolean; persistence: { lastSavedAt: number | null } };
    assert.equal(savePayload.success, true);
    assert.equal(typeof savePayload.persistence.lastSavedAt, "number");

    const closeResponse = await fetch(`${server.baseUrl}/admin/rooms/alpha-room/close`, {
      method: "POST",
      headers: ADMIN_HEADERS,
    });
    assert.equal(closeResponse.status, 200);

    const blockedJoin = await fetch(`${server.baseUrl}/rooms/alpha-room/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: registered.userId }),
    });
    assert.equal(blockedJoin.status, 409);

    const blockedState = await fetch(`${server.baseUrl}/rooms/alpha-room/state`);
    assert.equal(blockedState.status, 409);

    const healthResponse = await fetch(`${server.baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as {
      persistence: { configured: boolean; driver: string; path: string; lastSavedAt: number | null };
      roomDetails: Array<{ roomId: string; isActive: boolean }>;
    };
    assert.equal(health.persistence.configured, true);
    assert.equal(health.persistence.driver, "file");
    assert.equal(health.persistence.path.endsWith("runtime-state.json"), true);
    assert.equal(typeof health.persistence.lastSavedAt, "number");
    assert.equal(health.roomDetails.some((room) => room.roomId === "alpha-room" && room.isActive === false), true);
  } finally {
    await server.close();
    await temp.cleanup();
  }
});

test("SSE broker partitions room events and preserves room-local state payloads", () => {
  const { addClient, broadcast, broadcastEvent, getClientCountForRoom, resetBrokerForTests } = require("./sse/broker") as typeof import("./sse/broker");
  const { createRoom } = require("./state/rooms") as typeof import("./state/rooms");

  createRoom("Alpha Events", "alpha-events");
  createRoom("Beta Events", "beta-events");

  const alphaWrites: string[] = [];
  const betaWrites: string[] = [];
  const alphaClient = { write: (chunk: string) => { alphaWrites.push(chunk); return true; } };
  const betaClient = { write: (chunk: string) => { betaWrites.push(chunk); return true; } };

  addClient(alphaClient as never, undefined, "alpha-events");
  addClient(betaClient as never, undefined, "beta-events");
  alphaWrites.length = 0;
  betaWrites.length = 0;

  broadcastEvent({ type: "topicComplete", topicId: "alpha-events" }, "alpha-events");
  assert.equal(alphaWrites.length, 1);
  assert.equal(betaWrites.length, 0);

  broadcast();
  assert.equal(alphaWrites.length, 2);
  assert.equal(betaWrites.length, 1);
  assert.match(alphaWrites[1]!, /"roomId":"alpha-events"/);
  assert.match(betaWrites[0]!, /"roomId":"beta-events"/);
  assert.equal(getClientCountForRoom("alpha-events"), 1);
  assert.equal(getClientCountForRoom("beta-events"), 1);

  resetBrokerForTests();
});

test("persistence restore keeps room scores and checkpoint while resuming in paused mode", async () => {
  const temp = await createTempStateFilePath();
  configurePersistenceForTests(temp.filePath);

  try {
    const room = createRoom("Alpha Persistence", "alpha-persist");
    ingestQuestions([
      buildQuestion("q1", "topic-alpha", "Question one"),
      buildQuestion("q2", "topic-alpha", "Question two"),
    ]);
    startNextTopic("topic-alpha", room.roomId);

    const alice = registerPlayer("Alice", "persist-alice");
    assert.equal(alice.ok, true);
    initializePlayerRoom(alice.userId!, room.roomId);
    joinRoom(room.roomId, alice.userId!);

    await scoreCorrectAnswerAt(new Date("2026-03-23T09:00:00").getTime(), room.roomId, alice.userId!);

    start(room.roomId);
    skipToNext(room.roomId);
    pause(room.roomId);

    const beforeSave = getLeaderboardForPeriod("all-time", { roomId: room.roomId });
    assert.deepEqual(beforeSave.topScorers.map((entry) => entry.name), ["Alice"]);
    assert.equal(getStatus(room.roomId).questionIndex, 1);
    assert.equal(getStatus(room.roomId).running, false);

    const { flushPersistence } = await import("./state/persistence");
    await flushPersistence();

    resetRuntimeState();
    const restored = await restoreConfiguredPersistence();
    assert.equal(restored, true);

    const restoredRoom = getRoom(room.roomId);
    assert.equal(restoredRoom?.roomId, room.roomId);

    const afterRestore = getLeaderboardForPeriod("all-time", { roomId: room.roomId });
    assert.deepEqual(afterRestore.topScorers.map((entry) => entry.name), ["Alice"]);

    const restoredStatus = getStatus(room.roomId);
    assert.equal(restoredStatus.running, false);
    assert.equal(restoredStatus.phase, "OPEN");
    assert.equal(restoredStatus.questionIndex, 1);
    assert.equal(restoredStatus.endsAtMs, 0);
  } finally {
    await resetPersistenceState();
    await temp.cleanup();
  }
});

test("sqlite persistence restore keeps room scores and checkpoint while resuming in paused mode", async () => {
  const temp = await createTempStateDbPath();
  configurePersistenceForTests(temp.filePath, "sqlite");

  try {
    const room = createRoom("SQLite Persistence", "sqlite-persist");
    ingestQuestions([
      buildQuestion("q1", "topic-sqlite", "Question one"),
      buildQuestion("q2", "topic-sqlite", "Question two"),
    ]);
    startNextTopic("topic-sqlite", room.roomId);

    const alice = registerPlayer("Alice SQLite", "persist-alice-sqlite");
    assert.equal(alice.ok, true);
    initializePlayerRoom(alice.userId!, room.roomId);
    joinRoom(room.roomId, alice.userId!);

    await scoreCorrectAnswerAt(new Date("2026-03-23T09:00:00").getTime(), room.roomId, alice.userId!);

    start(room.roomId);
    skipToNext(room.roomId);
    pause(room.roomId);

    const beforeSave = getLeaderboardForPeriod("all-time", { roomId: room.roomId });
    assert.deepEqual(beforeSave.topScorers.map((entry) => entry.name), ["Alice_SQLite"]);
    assert.equal(getStatus(room.roomId).questionIndex, 1);
    assert.equal(getStatus(room.roomId).running, false);

    const { flushPersistence, getPersistenceStatus } = await import("./state/persistence");
    await flushPersistence();
    assert.equal(getPersistenceStatus().driver, "sqlite");
    assert.equal(getPersistenceStatus().path.endsWith("runtime-state.sqlite"), true);

    resetRuntimeState();
    const restored = await restoreConfiguredPersistence();
    assert.equal(restored, true);

    const restoredRoom = getRoom(room.roomId);
    assert.equal(restoredRoom?.roomId, room.roomId);

    const afterRestore = getLeaderboardForPeriod("all-time", { roomId: room.roomId });
    assert.deepEqual(afterRestore.topScorers.map((entry) => entry.name), ["Alice_SQLite"]);

    const restoredStatus = getStatus(room.roomId);
    assert.equal(restoredStatus.running, false);
    assert.equal(restoredStatus.phase, "OPEN");
    assert.equal(restoredStatus.questionIndex, 1);
    assert.equal(restoredStatus.endsAtMs, 0);
  } finally {
    await resetPersistenceState();
    await temp.cleanup();
  }
});

test("persistence cleanup drains writes and a failed flush does not poison later saves", async () => {
  const first = await createTempStateFilePath();
  const second = await createTempStateFilePath();

  try {
    configurePersistenceForTests(first.filePath);
    createRoom("Queued Persistence", "queued-persist");

    // A directory at the configured file path makes the atomic rename fail.
    await mkdir(first.filePath);
    const originalConsoleError = console.error;
    const persistenceErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      persistenceErrors.push(args);
    };
    try {
      await assert.rejects(async () => {
        const { flushPersistence } = await import("./state/persistence");
        await flushPersistence();
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(persistenceErrors.length, 1);
    await rm(first.filePath, { recursive: true, force: true });

    // The next configuration must still save successfully after that rejection.
    configurePersistenceForTests(second.filePath);
    createRoom("Recovered Persistence", "recovered-persist");
    const { flushPersistence } = await import("./state/persistence");
    assert.equal(await flushPersistence(), true);
    await access(second.filePath);

    // Cleanup disables scheduled writes and closes resources before paths vanish.
    await resetPersistenceState();
    await second.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(access(second.filePath));
  } finally {
    await resetPersistenceState();
    await first.cleanup();
    await second.cleanup();
  }
});

test("answer window rejects paused, early, and expired submissions using server time", () => {
  const paused = getAnswerWindowStatus();
  assert.equal(paused.accepting, false);
  assert.equal(paused.reason, "game_paused");

  start();
  const running = getAnswerWindowStatus();
  assert.equal(running.accepting, true);
  assert.equal(running.phase, "OPEN");

  const early = getAnswerWindowStatus("global", running.openStartMs - 1);
  assert.equal(early.accepting, false);
  assert.equal(early.reason, "not_started");

  const boundary = getAnswerWindowStatus("global", running.endsAtMs);
  assert.equal(boundary.accepting, false);
  assert.equal(boundary.reason, "too_late");

  pause();
  const pausedAgain = getAnswerWindowStatus();
  assert.equal(pausedAgain.accepting, false);
  assert.equal(pausedAgain.reason, "game_paused");
});

test("answer API refuses submissions before the controller starts", async () => {
  const server = await startTestServer();
  try {
    const registration = await fetch(`${server.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "WindowTester" }),
    });
    assert.equal(registration.status, 200);
    const player = await registration.json() as { userId: string };

    const answer = await fetch(`${server.baseUrl}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: player.userId, choiceId: "a" }),
    });
    assert.equal(answer.status, 409);
    const payload = await answer.json() as { accepted: boolean; reason: string };
    assert.equal(payload.accepted, false);
    assert.equal(payload.reason, "game_paused");
  } finally {
    await server.close();
  }
});
