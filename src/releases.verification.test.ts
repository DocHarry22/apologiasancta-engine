import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("release notifications are validated, persisted, paginated, and idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apologia-releases-"));
  process.env.RELEASES_FILE_PATH = join(directory, "releases.json");
  delete process.env.RESEND_API_KEY;
  delete process.env.RELEASE_EMAIL_FROM;

  try {
    const { createRelease, listReleases, markReleaseRead, validateReleaseInput } = await import("./state/releases");

    const invalid = validateReleaseInput({ repository: "unknown" });
    assert.equal(invalid.ok, false);

    const input = {
      commitSha: "abcdef1234567890",
      repository: "apologiasancta-engine" as const,
      category: "release notifications",
      title: "Release archive",
      summary: "Adds a durable release archive.",
      changes: ["Public archive endpoint"],
      fixes: [],
      features: ["Idempotent release records"],
      tests: ["Engine verification"],
      deploymentStatus: "deployed" as const,
      links: { commit: "https://github.com/DocHarry22/apologiasancta-engine/commit/abcdef1234567890" },
    };

    const first = await createRelease(input);
    const duplicate = await createRelease(input);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(first.record.id, duplicate.record.id);
    assert.equal(first.record.email.status, "skipped");

    const page = await listReleases({ page: 1, pageSize: 10, search: "archive" });
    assert.equal(page.total, 1);
    assert.equal(page.items[0]?.read, false);

    const updated = await markReleaseRead(first.record.id, true);
    assert.equal(updated?.read, true);
    const afterRead = await listReleases({ page: 1, pageSize: 10 });
    assert.equal(afterRead.items[0]?.read, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
