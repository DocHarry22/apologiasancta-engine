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
  assert.doesNotMatch(blueprint, /key:\s*STATE_DB_PATH/);
});

test("GitHub CI mirrors the production dependency install", async () => {
  const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");

  assert.match(workflow, /run:\s*npm ci --include=dev/);
});
