import { timingSafeEqual } from "node:crypto";

function configuredAdminToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.ADMIN_TOKEN?.trim();
  return token ? token : null;
}

export function isAdminTokenConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return configuredAdminToken(env) !== null;
}

export function verifyAdminToken(
  candidate: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): "valid" | "invalid" | "not_configured" {
  const expected = configuredAdminToken(env);
  if (!expected) return "not_configured";
  if (typeof candidate !== "string") return "invalid";

  const actualBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return "invalid";
  return timingSafeEqual(actualBuffer, expectedBuffer) ? "valid" : "invalid";
}

export function assertProductionAdminToken(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const token = configuredAdminToken(env);
  if (!token) throw new Error("Missing required production configuration: ADMIN_TOKEN");
  if (token.length < 32) {
    throw new Error("ADMIN_TOKEN must contain at least 32 characters in production");
  }
  if (/^(?:dev-|your-|replace|change-?me|placeholder|example)/i.test(token)) {
    throw new Error("ADMIN_TOKEN must not use a development or placeholder value in production");
  }
}
