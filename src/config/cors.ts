const LOCAL_DEVELOPMENT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:3002",
  "http://127.0.0.1:3003",
  "http://127.0.0.1:5173",
];

const CURRENT_PRODUCTION_ORIGIN = "https://sandybrown-bear-488955.hostingersite.com";

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function resolveAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const isProduction = env.NODE_ENV === "production";
  const includeLocal = !isProduction || env.ALLOW_LOCAL_ORIGINS === "true";
  const configured = [env.CORS_ORIGINS, env.ALLOWED_ORIGIN]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","));
  const candidates = [
    ...(isProduction ? [CURRENT_PRODUCTION_ORIGIN] : []),
    ...(includeLocal ? LOCAL_DEVELOPMENT_ORIGINS : []),
    ...configured,
  ];
  return [...new Set(candidates.map(normalizeOrigin).filter((origin): origin is string => Boolean(origin)))];
}

export const allowedOrigins = resolveAllowedOrigins();
