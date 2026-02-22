/**
 * Question ID generation utilities
 */

/** Map of topic IDs to their standard prefixes */
const TOPIC_PREFIX_MAP: Record<string, string> = {
  christology: "chr",
  mariology: "mar",
  ecclesiology: "ecc",
  sacraments: "sac",
  scripture: "scr",
  morality: "mor",
  liturgy: "lit",
  saints: "snt",
  prayer: "pry",
  eschatology: "esc",
  trinity: "tri",
  apologetics: "apo",
};

/**
 * Infer prefix from topic ID
 *
 * Uses known mapping or falls back to first 3 alpha characters
 */
export function inferPrefix(topicId: string): string {
  const normalized = topicId.toLowerCase().trim();

  if (TOPIC_PREFIX_MAP[normalized]) {
    return TOPIC_PREFIX_MAP[normalized];
  }

  // Extract first 3 alphabetic characters
  const alpha = normalized.replace(/[^a-z]/g, "");
  return alpha.slice(0, 3) || "que";
}

/**
 * Generate next question ID for a topic
 *
 * @param prefix - The ID prefix (e.g., "chr")
 * @param existingIds - Array of existing question IDs
 * @returns Next ID in sequence (e.g., "chr_0011")
 */
export function nextId(prefix: string, existingIds: string[]): string {
  const pattern = new RegExp(`^${prefix}_(\\d+)$`, "i");
  let maxNum = 0;

  for (const id of existingIds) {
    const match = id.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  const next = maxNum + 1;
  return `${prefix}_${next.toString().padStart(4, "0")}`;
}

/**
 * Sanitize a question ID
 *
 * - Lowercase
 * - Replace spaces/invalid chars with underscores
 * - Ensure valid format
 */
export function sanitizeId(id: string): string {
  return id
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Validate that an ID matches expected format
 */
export function isValidId(id: string): boolean {
  return /^[a-z][a-z0-9_-]*$/i.test(id);
}
