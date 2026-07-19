const DIFFICULTY_MODES = new Set(["easy", "medium", "hard", "expert", "trick"]);
const TRICK_CATEGORIES = new Set([
  "nature_vs_person",
  "infallibility_vs_impeccability",
  "veneration_vs_worship",
  "sign_vs_merely_symbolic",
  "dogma_vs_discipline",
  "development_vs_contradiction",
  "necessary_vs_sufficient",
  "premise_vs_conclusion",
  "initial_justification_vs_growth_in_grace",
  "material_vs_formal_rejection",
  "correct_doctrine_wrong_subject",
]);
const PUBLISHABLE_PERMISSION = new Set([
  "public_domain",
  "licensed",
  "permission_not_required_under_recorded_terms",
]);
const GENERIC_COMPARATIVE = new Set(["protestant", "protestants", "muslim", "muslims"]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function value(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function text(record: UnknownRecord, ...keys: string[]): string {
  const found = value(record, ...keys);
  return typeof found === "string" ? found.trim() : "";
}

function fail(code: string): never {
  throw new Error(`Phase 2 governance rejected canonical question: ${code}`);
}

function textFromStructured(valueToRead: unknown): string {
  if (typeof valueToRead === "string") return valueToRead.trim();
  const record = asRecord(valueToRead);
  if (!record) return "";
  for (const key of ["text", "body", "content", "value", "label"]) {
    const found = textFromStructured(record[key]);
    if (found) return found;
  }
  return "";
}

function records(valueToRead: unknown): UnknownRecord[] {
  if (!Array.isArray(valueToRead) || !valueToRead.every((item) => asRecord(item) !== null)) return [];
  return valueToRead as UnknownRecord[];
}

function optionId(option: UnknownRecord): string {
  return text(option, "id", "optionId", "option_id");
}

function optionExplanation(
  option: UnknownRecord,
  optionExplanations: UnknownRecord,
): string {
  const direct = textFromStructured(value(option, "explanation"));
  return direct || textFromStructured(optionExplanations[optionId(option)]);
}

function misconceptionCode(
  option: UnknownRecord,
  optionMisconceptions: UnknownRecord,
): string {
  return text(option, "misconceptionCode", "misconception_code", "misconceptionId", "misconception_id")
    || textFromStructured(optionMisconceptions[optionId(option)]);
}

function trueQualityFlag(valueToRead: unknown): boolean {
  if (valueToRead === true) return true;
  if (Array.isArray(valueToRead)) return valueToRead.some(trueQualityFlag);
  const record = asRecord(valueToRead);
  return record ? Object.values(record).some(trueQualityFlag) : false;
}

export function assertCanonicalGovernanceRecord(record: UnknownRecord): void {
  if (value(record, "governanceValidated", "governance_validated") !== true) {
    fail("governance.validation_attestation_required");
  }
  const stage = text(record, "governanceStage", "governance_stage");
  if (!["publication", "analytics_review"].includes(stage)) fail("workflow.publication_stage_required");

  const questionType = text(record, "questionType", "question_type", "type");
  if (questionType !== "single_choice") fail("question.single_choice_required");

  const objectiveId = text(record, "objectiveId", "objective_id");
  if (!objectiveId) fail("question.learning_objective_required");

  const difficulty = value(record, "difficulty");
  if (typeof difficulty !== "number" || !Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
    fail("question.difficulty_level_invalid");
  }
  const mode = text(record, "difficultyMode", "difficulty_mode");
  if (!DIFFICULTY_MODES.has(mode)) fail("question.difficulty_mode_invalid");
  const trickCategory = text(record, "trickCategory", "trick_category");
  if ((mode === "trick" && !TRICK_CATEGORIES.has(trickCategory)) || (mode !== "trick" && trickCategory)) {
    fail("question.trick_category_invalid");
  }
  if (!text(record, "equivalenceKey", "equivalence_key")) fail("question.equivalence_key_required");

  const prompt = textFromStructured(value(record, "prompt", "question"));
  if (!prompt) fail("question.prompt_required");
  if (/\b(?:protestants|muslims)\s+believe\b/i.test(prompt)) fail("comparative.generic_family_claim");
  if (!textFromStructured(value(record, "explanation", "correctAnswerExplanation", "correct_answer_explanation"))) {
    fail("question.correct_explanation_required");
  }

  const options = records(value(record, "options", "answerOptions", "answer_options", "choices"));
  if (options.length !== 4) fail("question.exactly_four_options");
  const optionIds = options.map(optionId);
  if (optionIds.some((id) => !id) || new Set(optionIds).size !== 4) fail("question.option_identifiers_invalid");

  const declaredCorrectId = text(record, "correctOptionId", "correct_option_id", "correctId", "correct_id");
  const flaggedCorrect = options.filter((option) => (
    value(option, "isCorrect", "is_correct") === true
  ));
  const correctId = declaredCorrectId || (flaggedCorrect.length === 1 ? optionId(flaggedCorrect[0]!) : "");
  if (
    !correctId
    || !optionIds.includes(correctId)
    || flaggedCorrect.length > 1
    || (declaredCorrectId && flaggedCorrect.length === 1 && optionId(flaggedCorrect[0]!) !== declaredCorrectId)
  ) {
    fail("question.one_best_answer_required");
  }

  const optionExplanations = asRecord(value(record, "optionExplanations", "option_explanations")) ?? {};
  const optionMisconceptions = asRecord(
    value(record, "optionMisconceptionCodes", "option_misconception_codes"),
  ) ?? {};
  for (const option of options) {
    const optionText = textFromStructured(value(option, "text", "content", "label", "value"));
    if (!optionText) fail("question.option_text_required");
    if (/^(?:all|none) of the above\.?$/i.test(optionText)) fail("question.forbidden_all_none_option");
    if (!optionExplanation(option, optionExplanations)) fail("question.option_explanation_required");
    if (optionId(option) !== correctId && !misconceptionCode(option, optionMisconceptions)) {
      fail("question.distractor_misconception_required");
    }
  }

  const qualityFlags = value(record, "qualityFlags", "quality_flags");
  if (trueQualityFlag(qualityFlags)) fail("question.prohibited_quality_flag");

  const rights = asRecord(value(record, "rightsMetadata", "rights_metadata"));
  if (!rights || !PUBLISHABLE_PERMISSION.has(text(rights, "permissionStatus", "permission_status"))) {
    fail("rights.question_permission_unverified");
  }
  const sources = records(value(record, "sources"));
  if (!sources.some((source) => (
    text(source, "authorityCategory", "authority_category")
    && text(source, "authorityCategory", "authority_category") !== "unverified"
    && text(source, "locator", "citationLocator", "citation_locator")
    && text(source, "citation")
    && PUBLISHABLE_PERMISSION.has(text(source, "permissionStatus", "permission_status"))
  ))) {
    fail("source.authoritative_located_rights_cleared_source_required");
  }

  const scope = asRecord(value(record, "denominationScope", "denomination_scope")) ?? {};
  const comparative = value(scope, "comparative") === true || value(scope, "comparative") === "true";
  if (comparative) {
    const tradition = text(scope, "tradition").toLowerCase();
    if (!tradition || GENERIC_COMPARATIVE.has(tradition)) fail("comparative.named_tradition_required");
    if (!text(scope, "sourceLocator", "source_locator")) fail("comparative.recognised_source_required");
    if ((difficulty >= 4 || mode === "expert" || mode === "trick") && !text(scope, "steelman")) {
      fail("comparative.advanced_steelman_required");
    }
  }
}
