export const PUBLIC_DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

export function normalizePublicDisplayName(raw: string): string {
  return raw.trim().replace(/\s+/g, "_").slice(0, 20);
}

export function isValidPublicDisplayName(value: string): boolean {
  return PUBLIC_DISPLAY_NAME_PATTERN.test(value);
}

