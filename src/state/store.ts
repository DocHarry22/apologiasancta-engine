/**
 * In-memory quiz state store
 *
 * This module now delegates to the RoundController for state management.
 */

import type { QuizState } from "../types/quiz";
import { getCurrentState } from "../engine/roundController";

/**
 * Get current quiz state from controller
 */
export function getState(): QuizState {
  return getCurrentState();
}
