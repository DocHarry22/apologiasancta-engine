import assert from "node:assert/strict";
import test from "node:test";
import { assertCanonicalGovernanceRecord } from "./governance";

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "phase2-governed-question",
    version: 1,
    objectiveId: "objective-1",
    difficulty: 4,
    difficultyMode: "expert",
    equivalenceKey: "doctrine.distinction.1",
    questionType: "single_choice",
    prompt: "Which answer best states the taught distinction?",
    options: [
      { id: "a", label: "Answer A", explanation: "Correct statement.", isCorrect: true },
      { id: "b", label: "Answer B", explanation: "Confuses related concepts.", misconceptionCode: "CONFUSION" },
      { id: "c", label: "Answer C", explanation: "Reverses the reasoning.", misconceptionCode: "REVERSAL" },
      { id: "d", label: "Answer D", explanation: "Uses the wrong category.", misconceptionCode: "CATEGORY_ERROR" },
    ],
    correctOptionId: "a",
    explanation: "Answer A states the distinction precisely.",
    denominationScope: {},
    rightsMetadata: { permissionStatus: "public_domain" },
    qualityFlags: {},
    sources: [{
      authorityCategory: "catechism",
      locator: "CCC 1",
      citation: "Catechism of the Catholic Church, 1",
      permissionStatus: "permission_not_required_under_recorded_terms",
    }],
    governanceStage: "publication",
    governanceValidated: true,
    ...overrides,
  };
}

test("engine accepts a complete, independently governed canonical record", () => {
  assert.doesNotThrow(() => assertCanonicalGovernanceRecord(validRecord()));
});

test("engine rejects ambiguous or incompletely explained assessment content", () => {
  assert.throws(
    () => assertCanonicalGovernanceRecord(validRecord({ qualityFlags: { ambiguous: true } })),
    /prohibited_quality_flag/,
  );
  const record = validRecord();
  (record.options as Array<Record<string, unknown>>)[2]!.explanation = "";
  assert.throws(() => assertCanonicalGovernanceRecord(record), /option_explanation_required/);
});

test("engine requires a named, sourced steelman for advanced comparative content", () => {
  assert.throws(
    () => assertCanonicalGovernanceRecord(validRecord({
      denominationScope: {
        comparative: true,
        tradition: "Reformed",
        sourceLocator: "Westminster Confession 27",
      },
    })),
    /advanced_steelman_required/,
  );
  assert.throws(
    () => assertCanonicalGovernanceRecord(validRecord({
      prompt: "What do Protestants believe about this doctrine?",
    })),
    /generic_family_claim/,
  );
});

test("engine permits only approved trick categories", () => {
  assert.throws(
    () => assertCanonicalGovernanceRecord(validRecord({
      difficultyMode: "trick",
    })),
    /trick_category_invalid/,
  );
  assert.doesNotThrow(() => assertCanonicalGovernanceRecord(validRecord({
    difficultyMode: "trick",
    trickCategory: "dogma_vs_discipline",
  })));
});
