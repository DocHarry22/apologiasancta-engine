import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import {
  getPoolQuestion,
  getQuestionById,
  getTotalBankSize,
  ingestQuestions,
  setActivePoolForRoom,
} from "./content/bank";
import { syncCatalogFromSource, type GitHubContentSource, type GitHubSyncResult } from "./content/github";
import { setTopicSequenceConfig } from "./config/topicSequence";
import {
  getControllerPersistenceSnapshot,
  getStatus,
  releaseQuizRuntimeStarts,
  start,
  startAutomaticQuizRuntime,
  startAutomaticQuizRuntimeForRoom,
  startNextTopic,
  holdQuizRuntimeStarts,
  skipToNext,
} from "./engine/roundController";
import { addClient, resetBrokerForTests } from "./sse/broker";
import { evaluateAnswers, getPlayerInfo, initializePlayerRoom, registerPlayer, submitAnswerForRegistered } from "./state/players";
import { closeGameplayRoom } from "./state/roomLifecycle";
import { createRoom, getRoom } from "./state/rooms";
import { initializeQuizRuntime } from "./startup/runtimeInitialization";
import { resetRuntimeState } from "./testSupport/runtimeTestUtils";

function buildQuestion(id: string, topicId: string, text: string) {
  return {
    id,
    topicId,
    question: text,
    choices: { A: "Alpha", B: "Beta", C: "Gamma", D: "Delta" },
    correctId: "A" as const,
    teaching: { title: `Teaching ${id}`, body: `Explanation for ${id}`, refs: ["CCC 1"] },
    difficulty: 3 as const,
    tags: ["runtime-safety"],
  };
}

function controllerSnapshotForRoom(roomId: string) {
  return getControllerPersistenceSnapshot().rooms.find((room) => room.roomId === roomId);
}

function createSseRecorder(roomId: string): string[] {
  const writes: string[] = [];
  const response = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as Response;
  addClient(response, undefined, roomId);
  return writes;
}

function dataMessageCount(writes: string[]): number {
  return writes.filter((write) => write.startsWith("data: ")).length;
}

function setRuntimeFlags(autoStart: string, continuous: string): () => void {
  const previousAutoStart = process.env.QUIZ_AUTO_START;
  const previousContinuous = process.env.QUIZ_CONTINUOUS;
  process.env.QUIZ_AUTO_START = autoStart;
  process.env.QUIZ_CONTINUOUS = continuous;
  return () => {
    if (previousAutoStart === undefined) delete process.env.QUIZ_AUTO_START;
    else process.env.QUIZ_AUTO_START = previousAutoStart;
    if (previousContinuous === undefined) delete process.env.QUIZ_CONTINUOUS;
    else process.env.QUIZ_CONTINUOUS = previousContinuous;
  };
}

test("closing a manually controlled room disposes only that controller and is idempotent", { concurrency: false }, (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_800_000_000_000 });
  const restoreFlags = setRuntimeFlags("false", "false");
  resetRuntimeState();

  try {
    const closingRoom = createRoom("Closing Manual Room", "closing-manual");
    const otherRoom = createRoom("Unaffected Manual Room", "unaffected-manual");
    const closingWrites = createSseRecorder(closingRoom.roomId);
    const otherWrites = createSseRecorder(otherRoom.roomId);

    assert.equal(start(closingRoom.roomId), true);
    assert.equal(start(otherRoom.roomId), true);
    const closeResult = closeGameplayRoom(closingRoom.roomId);
    assert.equal(closeResult.controllerDisposed, true);
    assert.equal(closeResult.room.isActive, false);
    const closedDataMessages = dataMessageCount(closingWrites);
    const closedSnapshot = controllerSnapshotForRoom(closingRoom.roomId);

    const repeatedClose = closeGameplayRoom(closingRoom.roomId);
    assert.equal(repeatedClose.controllerDisposed, false);
    assert.equal(repeatedClose.room.isActive, false);
    assert.equal(start(closingRoom.roomId), false);

    t.mock.timers.tick(28_000);

    assert.equal(
      dataMessageCount(closingWrites),
      closedDataMessages,
      "closed room must not broadcast state/events after disposal (SSE heartbeats may continue)"
    );
    assert.deepEqual(
      controllerSnapshotForRoom(closingRoom.roomId),
      closedSnapshot,
      "closed room controller must not mutate or schedule a new persistence snapshot"
    );
    assert.equal(getStatus(closingRoom.roomId).running, false);
    assert.equal(getStatus(closingRoom.roomId).endsAtMs, 0);
    assert.equal(getStatus(otherRoom.roomId).running, true);
    assert.equal(getStatus(otherRoom.roomId).phase, "LOCKED");
    assert.equal(dataMessageCount(otherWrites) > 2, true, "another room must continue broadcasting normally");
  } finally {
    resetRuntimeState();
    resetBrokerForTests();
    restoreFlags();
  }
});

test("closing during a continuous topic transition cancels every transition timer", { concurrency: false }, (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_100_000 });
  const restoreFlags = setRuntimeFlags("true", "true");
  resetRuntimeState();

  try {
    ingestQuestions([
      buildQuestion("transition-a", "transition-topic-a", "Transition A"),
      buildQuestion("transition-b", "transition-topic-b", "Transition B"),
    ]);
    const room = createRoom("Closing Transition Room", "closing-transition");
    setTopicSequenceConfig({
      topicSequence: ["transition-topic-a", "transition-topic-b"],
      autoAdvance: false,
      congratsDisplayTimeMs: 1_000,
      countdownSeconds: 1,
    }, room.roomId);
    startNextTopic("transition-topic-a", room.roomId);
    assert.equal(startAutomaticQuizRuntimeForRoom(room.roomId), true);
    skipToNext(room.roomId);
    assert.equal(getStatus(room.roomId).inTopicSummary, true);

    const firstClose = closeGameplayRoom(room.roomId);
    assert.equal(firstClose.controllerDisposed, true);
    const snapshotAfterClose = controllerSnapshotForRoom(room.roomId);
    t.mock.timers.tick(20_000);

    assert.deepEqual(controllerSnapshotForRoom(room.roomId), snapshotAfterClose);
    assert.equal(getStatus(room.roomId).currentTopicId, "transition-topic-a");
    assert.equal(getStatus(room.roomId).inTopicSummary, true, "final topic results remain inspectable after close");
    assert.equal(getRoom(room.roomId)?.isActive, false);
  } finally {
    resetRuntimeState();
    restoreFlags();
  }
});

test("GitHub sync retains the complete prior catalog while a staged fetch fails", { concurrency: false }, async () => {
  resetRuntimeState();
  const oldQuestion = buildQuestion("old-question", "old-topic", "Old live question");
  ingestQuestions([oldQuestion]);
  setActivePoolForRoom(["old-topic"], false, "global");

  let rejectSecondQuestion!: (error: Error) => void;
  let secondQuestionRequested!: () => void;
  const secondQuestionStarted = new Promise<void>((resolve) => { secondQuestionRequested = resolve; });
  const failedQuestion = new Promise<never>((_resolve, reject) => { rejectSecondQuestion = reject; });
  const source: GitHubContentSource = {
    async fetchJson<T>(path: string): Promise<T> {
      if (path.endsWith("index.json")) {
        return { topics: [{ id: "new-topic" }] } as T;
      }
      if (path.endsWith("one.json")) {
        return buildQuestion("new-one", "new-topic", "New staged one") as T;
      }
      secondQuestionRequested();
      return failedQuestion as Promise<T>;
    },
    async listDirectory(path, type) {
      if (type === "dir") return ["new-topic"];
      if (path.endsWith("new-topic/questions")) return ["one.json", "two.json"];
      return [];
    },
  };

  const syncPromise = syncCatalogFromSource(source, "content/topics");
  await secondQuestionStarted;
  assert.equal(getTotalBankSize(), 1);
  assert.equal(getQuestionById("old-question")?.engineFormat.text, "Old live question");
  assert.equal(getPoolQuestion(0)?.text, "Old live question");

  rejectSecondQuestion(new Error("simulated GitHub outage"));
  const result = await syncPromise;
  assert.equal(result.success, false);
  assert.equal(getTotalBankSize(), 1);
  assert.equal(getQuestionById("old-question")?.engineFormat.text, "Old live question");
  assert.equal(getQuestionById("new-one"), null);
  assert.equal(getPoolQuestion(0)?.text, "Old live question");
  resetRuntimeState();
});

test("GitHub sync rejects invalid content without exposing it and commits valid content atomically", { concurrency: false }, async () => {
  resetRuntimeState();
  ingestQuestions([buildQuestion("stable-id", "stable-topic", "Stable live version")]);
  setActivePoolForRoom(["stable-topic"], false, "global");

  const buildSource = (question: unknown): GitHubContentSource => ({
    async fetchJson<T>(path: string): Promise<T> {
      if (path.endsWith("index.json")) return { topics: [{ id: "stable-topic" }] } as T;
      return question as T;
    },
    async listDirectory(_path, type) {
      return type === "dir" ? ["stable-topic"] : ["question.json"];
    },
  });

  const invalid = buildQuestion("stable-id", "stable-topic", "Invalid replacement") as Record<string, unknown>;
  invalid.correctId = "Z";
  const invalidResult = await syncCatalogFromSource(buildSource(invalid), "content/topics");
  assert.equal(invalidResult.success, false);
  assert.equal(getQuestionById("stable-id")?.engineFormat.text, "Stable live version");

  const validResult = await syncCatalogFromSource(
    buildSource(buildQuestion("stable-id", "stable-topic", "Validated replacement")),
    "content/topics"
  );
  assert.equal(validResult.success, true);
  assert.equal(getQuestionById("stable-id")?.engineFormat.text, "Validated replacement");
  assert.equal(
    getPoolQuestion(0)?.text,
    "Stable live version",
    "an already-selected room pool must remain stable through its answer window"
  );
  resetRuntimeState();
});

async function runStartupOrderingCase(sync: () => Promise<GitHubSyncResult>) {
  let automaticStartCalls = 0;
  return initializeQuizRuntime({
    holdRuntimeStarts: holdQuizRuntimeStarts,
    releaseRuntimeStarts: releaseQuizRuntimeStarts,
    restorePersistedState: async () => true,
    hasGitHubSyncConfig: () => true,
    syncFromGitHub: sync,
    startAutomaticQuizRuntime: () => {
      automaticStartCalls += 1;
      return startAutomaticQuizRuntime();
    },
  }).then((result) => ({ result, automaticStartCalls }));
}

test("startup holds OPEN timers until sync settles and starts exactly once after success", { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_200_000 });
  const restoreFlags = setRuntimeFlags("true", "true");
  resetRuntimeState();

  try {
    ingestQuestions([buildQuestion("startup-question", "startup-topic", "Startup question")]);
    setActivePoolForRoom(["startup-topic"], false, "global");
    const player = registerPlayer("Startup_Player");
    initializePlayerRoom(player.userId!, "global");
    assert.equal(submitAnswerForRegistered(0, player.userId!, "a", "global").accepted, true);
    evaluateAnswers(0, "A", {
      openStartMs: Date.now() - 1_000,
      openDurationMs: 25_000,
      difficulty: 3,
    }, "global");
    const scoreBeforeStartup = getPlayerInfo(player.userId!, "global")!.totalPoints;

    let resolveSync!: (result: GitHubSyncResult) => void;
    const pendingSync = new Promise<GitHubSyncResult>((resolve) => { resolveSync = resolve; });
    const initialization = runStartupOrderingCase(() => pendingSync);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(getStatus("global").running, false);
    assert.equal(getStatus("global").endsAtMs, 0, "no OPEN deadline may exist while content is syncing");
    resolveSync({ success: true, topicsLoaded: 1, questionsLoaded: 1, errors: [] });
    const { result, automaticStartCalls } = await initialization;

    assert.equal(automaticStartCalls, 1);
    assert.deepEqual(result.automaticRooms, ["global"]);
    assert.equal(getStatus("global").running, true);
    assert.equal(getStatus("global").endsAtMs > Date.now(), true);
    assert.equal(
      getPlayerInfo(player.userId!, "global")!.totalPoints,
      scoreBeforeStartup,
      "startup must not reset scores through a second automatic start"
    );
  } finally {
    releaseQuizRuntimeStarts();
    resetRuntimeState();
    restoreFlags();
  }
});

test("startup starts exactly once after a safely contained sync failure and respects explicit false flags", { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_300_000 });
  const restoreFlags = setRuntimeFlags("false", "false");
  resetRuntimeState();

  try {
    const failed = await runStartupOrderingCase(async () => {
      throw new Error("simulated startup sync failure");
    });
    assert.equal(failed.automaticStartCalls, 1);
    assert.equal(failed.result.syncResult?.success, false);
    assert.deepEqual(failed.result.automaticRooms, []);
    assert.equal(getStatus("global").running, false);
    assert.equal(getStatus("global").endsAtMs, 0);
  } finally {
    releaseQuizRuntimeStarts();
    resetRuntimeState();
    restoreFlags();
  }
});
