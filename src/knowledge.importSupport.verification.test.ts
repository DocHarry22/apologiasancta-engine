import assert from "node:assert/strict";
import test from "node:test";
import { validateCanonicalIdBatch } from "./knowledge/importSupport";

test("import existence batches validate and deduplicate canonical ids", () => {
  assert.deepEqual(
    validateCanonicalIdBatch(["claim:alpha", "claim:alpha", "source:beta"]),
    ["claim:alpha", "source:beta"]
  );
  assert.deepEqual(validateCanonicalIdBatch(undefined), []);
});

test("import existence batches reject malformed ids and oversized requests", () => {
  assert.throws(() => validateCanonicalIdBatch(["not canonical"]), /stable canonical id/);
  assert.throws(
    () => validateCanonicalIdBatch(Array.from({ length: 1001 }, (_, index) => `claim:item-${index}`)),
    /exceeds 1000 entries/
  );
});
