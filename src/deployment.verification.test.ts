import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";

const repositoryRoot = resolve(__dirname, "..");

test("Render installs build tooling and uses managed PostgreSQL", async () => {
  const blueprint = await readFile(resolve(repositoryRoot, "render.yaml"), "utf8");

  assert.match(blueprint, /buildCommand:\s*npm ci --include=dev && npm run build/);
  assert.match(blueprint, /key:\s*DATABASE_URL[\s\S]*?fromDatabase:/);
  assert.match(blueprint, /key:\s*STATE_PERSISTENCE_DRIVER\s*\n\s*value:\s*postgres/);
  assert.match(blueprint, /key:\s*PLAYER_JOIN_SECRET\s*\n\s*sync:\s*false/);
  assert.match(blueprint, /key:\s*RATE_LIMIT_REGISTER_MAX\s*\n\s*value:\s*"120"/);
  assert.match(blueprint, /key:\s*RATE_LIMIT_REGISTER_WINDOW_MS\s*\n\s*value:\s*"600000"/);
  assert.doesNotMatch(blueprint, /key:\s*STATE_DB_PATH/);
});

test("environment examples never provide a copyable player-secret placeholder", async () => {
  const examples = await Promise.all([
    readFile(resolve(repositoryRoot, ".env.example"), "utf8"),
    readFile(resolve(repositoryRoot, "env.production.example"), "utf8"),
  ]);

  for (const example of examples) {
    assert.match(example, /^PLAYER_JOIN_SECRET=\s*$/m);
    assert.doesNotMatch(example, /^PLAYER_JOIN_SECRET=(?:replace-with-|your-|change-?me|placeholder)/im);
  }
});

test("GitHub CI mirrors the production dependency install", async () => {
  const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const npmConfiguration = await readFile(resolve(repositoryRoot, ".npmrc"), "utf8");

  assert.match(workflow, /run:\s*npm ci --include=dev/);
  assert.match(npmConfiguration, /^include=dev$/m);
});
