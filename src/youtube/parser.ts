/**
 * YouTube Chat Message Parser
 * 
 * Parses chat messages for quiz answer commands.
 */

/** Valid choice values */
export type Choice = "a" | "b" | "c" | "d";

/** Result of parsing a chat message */
export interface ParseResult {
  choice: Choice | null;
  rawText: string;
}

/**
 * Parse a chat message for answer commands
 * 
 * Recognizes patterns:
 * - !A, !B, !C, !D (case insensitive)
 * - Can be anywhere in the message (first match wins)
 * - Returns null if no valid command found
 * 
 * @param displayMessage - The chat message text
 * @returns The choice (lowercase) or null if no command found
 */
export function parseChoice(displayMessage: string): Choice | null {
  if (!displayMessage || typeof displayMessage !== "string") {
    return null;
  }

  // Match !A, !B, !C, !D anywhere in message (case insensitive)
  // \b ensures we match word boundaries to avoid false positives
  const match = displayMessage.match(/![AaBbCcDd]\b/);
  
  if (!match) {
    return null;
  }

  // Extract the letter and lowercase it
  const letter = match[0].charAt(1).toLowerCase();
  
  if (letter === "a" || letter === "b" || letter === "c" || letter === "d") {
    return letter;
  }

  return null;
}

/**
 * Parse message and return full result with original text
 * 
 * @param displayMessage - The chat message text
 * @returns ParseResult with choice and original text
 */
export function parseMessage(displayMessage: string): ParseResult {
  return {
    choice: parseChoice(displayMessage),
    rawText: displayMessage || "",
  };
}

/**
 * Check if a message contains any answer command
 * 
 * @param displayMessage - The chat message text
 * @returns true if message contains a valid answer command
 */
export function hasAnswerCommand(displayMessage: string): boolean {
  return parseChoice(displayMessage) !== null;
}
