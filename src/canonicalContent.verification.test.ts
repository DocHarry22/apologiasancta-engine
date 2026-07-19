import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "./app";
import {
  getCanonicalContentCache,
  getContentBankPersistenceSnapshot,
  getActivePoolSize,
  getPoolQuestion,
  getQuestionById,
  getTotalBankSize,
  hydrateContentBankPersistenceSnapshot,
  ingestQuestions,
  setActivePoolForRoom,
} from "./content/bank";
import {
  assertCanonicalContentConfiguration,
  getCanonicalContentStatus,
  refreshCanonicalContent,
  resetCanonicalContentClientForTests,
  setCanonicalFetchForTests,
} from "./content/canonical";
import { assertProductionAdminToken } from "./security/adminToken";
import { resetRuntimeState, startTestServer } from "./testSupport/runtimeTestUtils";
import { getAnswerWindowStatus, getStatus, start } from "./engine/roundController";
import { syncFromGitHub } from "./content/github";

const STRONG_TOKEN = "canonical-test-token-that-is-longer-than-thirty-two-bytes";

function installCanonicalEnvironment(): () => void {
  const previous = {
    url: process.env.CONTENT_API_URL,
    token: process.env.CONTENT_API_TOKEN,
    required: process.env.CONTENT_API_REQUIRED,
  };
  process.env.CONTENT_API_URL = "https://content.test/api/v1/engine/questions";
  process.env.CONTENT_API_TOKEN = STRONG_TOKEN;
  process.env.CONTENT_API_REQUIRED = "true";
  return () => {
    if (previous.url === undefined) delete process.env.CONTENT_API_URL;
    else process.env.CONTENT_API_URL = previous.url;
    if (previous.token === undefined) delete process.env.CONTENT_API_TOKEN;
    else process.env.CONTENT_API_TOKEN = previous.token;
    if (previous.required === undefined) delete process.env.CONTENT_API_REQUIRED;
    else process.env.CONTENT_API_REQUIRED = previous.required;
  };
}

function canonicalQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: "canonical-question-1",
    version: 2,
    topicId: "foundations-group",
    difficulty: 4,
    prompt: "Which answer is correct?",
    options: [
      { id: "option-a", label: "Alpha" },
      { id: "option-b", label: "Beta" },
      { id: "option-c", label: "Gamma" },
      { id: "option-d", label: "Delta" },
    ],
    correctOptionId: "option-b",
    explanation: "Beta is the validated answer.",
    sources: ["Fixture source"],
    tags: ["fixture"],
    ...overrides,
  };
}

function feed(question = canonicalQuestion()) {
  return {
    version: "feed-v2",
    updatedAt: "2026-07-17T12:00:00.000Z",
    questions: [question],
  };
}

test("canonical refresh authenticates, maps the feed, persists its ETag, and keeps answers private", { concurrency: false }, async () => {
  const restoreEnvironment = installCanonicalEnvironment();
  resetRuntimeState();
  let requestCount = 0;
  try {
    setCanonicalFetchForTests(async (_input, init) => {
      requestCount += 1;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${STRONG_TOKEN}`);
      assert.equal(init?.redirect, "error");
      if (requestCount === 2) {
        assert.equal(headers.get("if-none-match"), '"feed-v2"');
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify({
        ...feed(),
        questions: [
          canonicalQuestion(),
          canonicalQuestion({ id: "draft-question", status: "draft" }),
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"feed-v2"' },
      });
    });

    const refreshed = await refreshCanonicalContent();
    assert.equal(refreshed.success, true);
    assert.equal(refreshed.questionsLoaded, 1);
    assert.equal(getTotalBankSize(), 1);
    assert.equal(getQuestionById("draft-question"), null);
    assert.equal(getQuestionById("canonical-question-1")?.engineFormat.correctId, "B");
    assert.equal(getCanonicalContentCache()?.etag, '"feed-v2"');

    setActivePoolForRoom(["foundations-group"], false, "global");
    const server = await startTestServer();
    try {
      const stateText = await (await fetch(`${server.baseUrl}/state`)).text();
      assert.equal(stateText.includes("correctId"), false);
      assert.equal(stateText.includes("validated answer"), false);
      const topicText = await (await fetch(`${server.baseUrl}/topics/foundations-group`)).text();
      assert.equal(topicText.includes("correctId"), false);
      assert.equal(topicText.includes("validated answer"), false);
    } finally {
      await server.close();
    }

    const persisted = JSON.parse(JSON.stringify(getContentBankPersistenceSnapshot()));
    resetRuntimeState();
    hydrateContentBankPersistenceSnapshot(persisted);
    const unchanged = await refreshCanonicalContent();
    assert.equal(unchanged.success, true);
    assert.equal(unchanged.notModified, true);
    assert.equal(getPoolQuestion(0)?.text, "Which answer is correct?");
    assert.equal(getCanonicalContentStatus().ready, true);
  } finally {
    resetCanonicalContentClientForTests();
    resetRuntimeState();
    restoreEnvironment();
  }
});

test("invalid or regressed canonical content retains the last validated catalog and active revision", { concurrency: false }, async () => {
  const restoreEnvironment = installCanonicalEnvironment();
  resetRuntimeState();
  let responsePayload: unknown = feed();
  try {
    setCanonicalFetchForTests(async () => new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    assert.equal((await refreshCanonicalContent()).success, true);
    setActivePoolForRoom(["foundations-group"], false, "global");

    responsePayload = feed(canonicalQuestion({ prompt: "Changed without a version increment" }));
    const rejected = await refreshCanonicalContent();
    assert.equal(rejected.success, false);
    assert.match(rejected.errors[0]!, /without a version increment/);
    assert.equal(rejected.staleCacheRetained, true);
    assert.equal(getQuestionById("canonical-question-1")?.engineFormat.text, "Which answer is correct?");
    assert.equal(getPoolQuestion(0)?.text, "Which answer is correct?");
    assert.equal(getCanonicalContentStatus().state, "stale");

    responsePayload = feed(canonicalQuestion({ version: 1 }));
    const regressed = await refreshCanonicalContent();
    assert.equal(regressed.success, false);
    assert.match(regressed.errors[0]!, /version regressed/);
    assert.equal(getTotalBankSize(), 1);
  } finally {
    resetCanonicalContentClientForTests();
    resetRuntimeState();
    restoreEnvironment();
  }
});

test("protected PostgREST view rows map to the existing four-choice engine format", { concurrency: false }, async () => {
  const restoreEnvironment = installCanonicalEnvironment();
  resetRuntimeState();
  try {
    setCanonicalFetchForTests(async () => new Response(JSON.stringify({ data: [{
      question_id: "5f95e356-807c-4f8d-a490-df774760641f",
      stable_key: "stable-live-key",
      version: 7,
      group_id: "group-uuid",
      difficulty: 2,
      question_type: "multiple_choice",
      prompt: { text: "Mapped structured prompt" },
      correct_answer_explanation: { body: "Reveal-only explanation", refs: ["Ref 1"] },
      updated_at: "2026-07-17T11:30:00.000Z",
      options: [
        { id: "one", position: 1, content: { text: "One" }, is_correct: false },
        { id: "two", position: 2, content: { text: "Two" }, is_correct: true },
        { id: "three", position: 3, content: { text: "Three" }, is_correct: false },
        { id: "four", position: 4, content: { text: "Four" }, is_correct: false },
      ],
    }] }), { status: 200 }));

    const result = await refreshCanonicalContent();
    assert.equal(result.success, true);
    const entry = getQuestionById("stable-live-key");
    assert.equal(entry?.topicId, "group-uuid");
    assert.equal(entry?.engineFormat.text, "Mapped structured prompt");
    assert.equal(entry?.engineFormat.correctId, "B");
    assert.equal(entry?.engineFormat.teaching.body, "Reveal-only explanation");
  } finally {
    resetCanonicalContentClientForTests();
    resetRuntimeState();
    restoreEnvironment();
  }
});

test("canonical request timeout retains the validated stale cache", { concurrency: false }, async () => {
  const restoreEnvironment = installCanonicalEnvironment();
  const previousTimeout = process.env.CONTENT_API_TIMEOUT_MS;
  process.env.CONTENT_API_TIMEOUT_MS = "500";
  resetRuntimeState();
  let requestCount = 0;
  try {
    setCanonicalFetchForTests(async (_input, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify(feed()), { status: 200 });
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        const onAbort = () => {
          clearTimeout(failsafe);
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason);
        };
        const failsafe = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          reject(new Error("Canonical abort signal did not fire before the test failsafe."));
        }, 2_000);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    assert.equal((await refreshCanonicalContent()).success, true);

    const timedOut = await refreshCanonicalContent();
    assert.equal(timedOut.success, false);
    assert.equal(timedOut.staleCacheRetained, true);
    assert.match(timedOut.errors[0]!, /timed out/i);
    assert.equal(getQuestionById("canonical-question-1")?.engineFormat.text, "Which answer is correct?");
  } finally {
    if (previousTimeout === undefined) delete process.env.CONTENT_API_TIMEOUT_MS;
    else process.env.CONTENT_API_TIMEOUT_MS = previousTimeout;
    resetCanonicalContentClientForTests();
    resetRuntimeState();
    restoreEnvironment();
  }
});

test("required canonical mode blocks every legacy catalog mutation and purges a legacy selected pool", { concurrency: false }, async () => {
  const restoreEnvironment = installCanonicalEnvironment();
  resetRuntimeState();
  try {
    ingestQuestions([{
      id: "legacy-question",
      topicId: "legacy-topic",
      difficulty: 3,
      question: "Legacy content must not survive canonical adoption",
      choices: { A: "A", B: "B", C: "C", D: "D" },
      correctId: "A",
      teaching: { title: "Legacy", body: "Legacy explanation" },
    }]);
    setActivePoolForRoom(["legacy-topic"], false, "global");
    assert.equal(getActivePoolSize(), 1);

    setCanonicalFetchForTests(async () => new Response(JSON.stringify(feed()), {
      status: 200,
      headers: { etag: '"canonical-authority"' },
    }));
    assert.equal((await refreshCanonicalContent()).success, true);
    assert.equal(getQuestionById("legacy-question"), null);
    assert.equal(getActivePoolSize(), 0, "a legacy selected pool must be purged at canonical adoption");
    setActivePoolForRoom(["foundations-group"], false, "global");

    const server = await startTestServer();
    try {
      const headers = { "content-type": "application/json", "x-admin-token": "dev-admin-token" };
      const mutations = [
        { path: "/admin/content/import", body: { questions: [canonicalQuestion({ id: "legacy-import" })] } },
        { path: "/admin/quiz/set", body: { topicIds: [] } },
        { path: "/admin/content/clear", body: {} },
        { path: "/admin/content/github/clear", body: {} },
        { path: "/admin/content/sync", body: {} },
      ];
      for (const mutation of mutations) {
        const response = await fetch(`${server.baseUrl}${mutation.path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(mutation.body),
        });
        assert.equal(response.status, 409, mutation.path);
        const payload = await response.json() as { code?: string };
        assert.equal(payload.code, "canonical_content_required", mutation.path);
        assert.equal(getTotalBankSize(), 1);
        assert.equal(getActivePoolSize(), 1);
        assert.equal(getPoolQuestion(0)?.text, "Which answer is correct?");
        assert.equal(getCanonicalContentCache()?.feedVersion, "feed-v2");
      }

      const directGitHubSync = await syncFromGitHub();
      assert.equal(directGitHubSync.success, false);
      assert.match(directGitHubSync.errors[0]!, /disabled while canonical content is required/);
    } finally {
      await server.close();
    }
  } finally {
    resetCanonicalContentClientForTests();
    resetRuntimeState();
    restoreEnvironment();
  }
});

test("required canonical mode returns 503 instead of bundled fixtures and recovers only through canonical refresh", { concurrency: false }, async () => {
  const restoreEnvironment = installCanonicalEnvironment();
  resetRuntimeState();
  try {
    setCanonicalFetchForTests(async () => new Response(JSON.stringify(feed()), {
      status: 200,
      headers: { etag: '"canonical-recovery"' },
    }));
    const server = await startTestServer();
    try {
      for (const path of ["/state", "/events", "/rooms/global/state", "/rooms/global/events", "/health"]) {
        const response = await fetch(`${server.baseUrl}${path}`);
        assert.equal(response.status, 503, path);
        const body = await response.text();
        assert.equal(body.includes("Council of Nicaea"), false, path);
        assert.equal(body.includes("canonical_content_unavailable") || path === "/health", true, path);
      }
      assert.equal(start("global"), false);
      assert.equal(getStatus("global").totalQuestions, 0);
      assert.equal(getStatus("global").questionSource, "canonical_unavailable");
      assert.equal(getAnswerWindowStatus("global").reason, "content_unavailable");

      const refresh = await fetch(`${server.baseUrl}/admin/content/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": "dev-admin-token" },
        body: JSON.stringify({ refreshActivePool: true }),
      });
      assert.equal(refresh.status, 200);
      const refreshBody = await refresh.json() as { activePoolRefreshed: boolean; activePoolSize: number };
      assert.equal(refreshBody.activePoolRefreshed, true);
      assert.equal(refreshBody.activePoolSize, 1);

      const recoveredState = await fetch(`${server.baseUrl}/state`);
      assert.equal(recoveredState.status, 200);
      const recoveredText = await recoveredState.text();
      assert.equal(recoveredText.includes("Which answer is correct?"), true);
      assert.equal(recoveredText.includes("correctId"), false);
      assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);
    } finally {
      await server.close();
    }
  } finally {
    resetCanonicalContentClientForTests();
    resetRuntimeState();
    restoreEnvironment();
  }
});

test("legacy catalog controls remain available when canonical content is not required", { concurrency: false }, async () => {
  const restoreEnvironment = installCanonicalEnvironment();
  process.env.CONTENT_API_REQUIRED = "false";
  resetRuntimeState();
  try {
    const server = await startTestServer();
    try {
      const headers = { "content-type": "application/json", "x-admin-token": "dev-admin-token" };
      const imported = await fetch(`${server.baseUrl}/admin/content/import`, {
        method: "POST",
        headers,
        body: JSON.stringify({ questions: [{
          id: "legacy-allowed",
          topicId: "legacy-allowed-topic",
          difficulty: 3,
          question: "Legacy mode question",
          choices: { A: "A", B: "B", C: "C", D: "D" },
          correctId: "A",
          teaching: { title: "Legacy", body: "Legacy mode remains supported" },
        }] }),
      });
      assert.equal(imported.status, 200);
      assert.equal((await fetch(`${server.baseUrl}/admin/quiz/set`, {
        method: "POST",
        headers,
        body: JSON.stringify({ topicIds: ["legacy-allowed-topic"], shuffle: false }),
      })).status, 200);
      assert.equal((await fetch(`${server.baseUrl}/admin/content/clear`, {
        method: "POST",
        headers,
        body: "{}",
      })).status, 200);
      assert.equal(getTotalBankSize(), 0);
      assert.equal(getStatus("global").questionSource, "legacy_fallback");
    } finally {
      await server.close();
    }
  } finally {
    resetCanonicalContentClientForTests();
    resetRuntimeState();
    restoreEnvironment();
  }
});

test("admin routes fail closed without ADMIN_TOKEN and production secrets reject weak configuration", { concurrency: false }, async () => {
  const previousAdminToken = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/admin/status`, {
      headers: { "x-admin-token": "dev-admin-token" },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("dev-admin-token"), false);

    assert.throws(
      () => assertProductionAdminToken({ NODE_ENV: "production", ADMIN_TOKEN: "dev-admin-token" }),
      /at least 32 characters|placeholder/
    );
    assert.throws(
      () => assertCanonicalContentConfiguration({
        NODE_ENV: "production",
        CONTENT_API_REQUIRED: "true",
        CONTENT_API_URL: "https://content.test/api/v1/engine/questions",
      }),
      /must be configured together/
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousAdminToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousAdminToken;
  }
});
