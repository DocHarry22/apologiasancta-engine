/**
 * Question validation and normalization utilities
 *
 * Validates incoming questions and normalizes them to the engine's internal format.
 */

import { QuestionData } from "./questions";

/** Choice ID as used in UI format */
export type UIChoiceId = "A" | "B" | "C" | "D";

/** Question format from UI (choices as object) */
export interface UIQuestion {
  id: string;
  topicId: string;
  difficulty?: 1 | 2 | 3 | 4 | 5 | "easy" | "medium" | "hard";
  question: string;
  choices: {
    A: string;
    B: string;
    C: string;
    D: string;
  };
  correctId: UIChoiceId;
  teaching: {
    title: string;
    body: string;
    refs?: string[];
  };
  tags?: string[];
}

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a question object from UI format
 */
export function validateQuestion(obj: unknown): ValidationResult {
  const errors: string[] = [];

  if (!obj || typeof obj !== "object") {
    return { valid: false, errors: ["Question must be an object"] };
  }

  const q = obj as Record<string, unknown>;

  // Required string fields
  if (typeof q.id !== "string" || !q.id.trim()) {
    errors.push("id is required and must be a non-empty string");
  }

  if (typeof q.topicId !== "string" || !q.topicId.trim()) {
    errors.push("topicId is required and must be a non-empty string");
  }

  if (typeof q.question !== "string" || !q.question.trim()) {
    errors.push("question is required and must be a non-empty string");
  }

  // Choices validation
  if (!q.choices || typeof q.choices !== "object") {
    errors.push("choices is required and must be an object");
  } else {
    const choices = q.choices as Record<string, unknown>;
    for (const key of ["A", "B", "C", "D"]) {
      if (typeof choices[key] !== "string" || !(choices[key] as string).trim()) {
        errors.push(`choices.${key} is required and must be a non-empty string`);
      }
    }
  }

  // Correct answer validation
  if (!["A", "B", "C", "D"].includes(q.correctId as string)) {
    errors.push('correctId must be one of "A", "B", "C", "D"');
  }

  // Teaching validation
  if (!q.teaching || typeof q.teaching !== "object") {
    errors.push("teaching is required and must be an object");
  } else {
    const teaching = q.teaching as Record<string, unknown>;
    if (typeof teaching.title !== "string" || !teaching.title.trim()) {
      errors.push("teaching.title is required and must be a non-empty string");
    }
    if (typeof teaching.body !== "string" || !teaching.body.trim()) {
      errors.push("teaching.body is required and must be a non-empty string");
    }
    if (teaching.refs !== undefined && !Array.isArray(teaching.refs)) {
      errors.push("teaching.refs must be an array if provided");
    }
  }

  // Optional field validation
  if (q.difficulty !== undefined) {
    const d = q.difficulty;
    const validNumeric = typeof d === "number" && d >= 1 && d <= 5;
    const validString = typeof d === "string" && ["easy", "medium", "hard"].includes(d);
    if (!validNumeric && !validString) {
      errors.push('difficulty must be 1-5 or one of "easy", "medium", "hard"');
    }
  }

  if (q.tags !== undefined && !Array.isArray(q.tags)) {
    errors.push("tags must be an array if provided");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convert a UI question to engine QuestionData format
 */
export function normalizeToEngine(uiQuestion: UIQuestion): QuestionData {
  const choiceLabels: Record<UIChoiceId, string> = {
    A: "A",
    B: "B",
    C: "C",
    D: "D",
  };

  const themeTitle = uiQuestion.topicId
    .replace(/[_-]+/g, " ")
    .trim()
    .toUpperCase();

  return {
    text: uiQuestion.question,
    choices: [
      { id: "A", label: choiceLabels.A, text: uiQuestion.choices.A },
      { id: "B", label: choiceLabels.B, text: uiQuestion.choices.B },
      { id: "C", label: choiceLabels.C, text: uiQuestion.choices.C },
      { id: "D", label: choiceLabels.D, text: uiQuestion.choices.D },
    ],
    correctId: uiQuestion.correctId,
    teaching: {
      title: uiQuestion.teaching.title,
      body: uiQuestion.teaching.body,
      refs: uiQuestion.teaching.refs || [],
    },
    themeTitle,
  };
}

/**
 * Validate an array of questions and return detailed results
 */
export function validateQuestionBatch(
  questions: unknown[]
): { valid: UIQuestion[]; errors: Array<{ index: number; errors: string[] }> } {
  const valid: UIQuestion[] = [];
  const errors: Array<{ index: number; errors: string[] }> = [];

  for (let i = 0; i < questions.length; i++) {
    const result = validateQuestion(questions[i]);
    if (result.valid) {
      valid.push(questions[i] as UIQuestion);
    } else {
      errors.push({ index: i, errors: result.errors });
    }
  }

  return { valid, errors };
}
