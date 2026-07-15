import type { NextFunction, Request, RequestHandler, Response } from "express";

type RateLimitEntry = { count: number; resetAt: number };
type RateLimitOptions = {
  name: string;
  max: number;
  windowMs: number;
  message: string;
  key?: (req: Request) => string;
};

const cleanupTimers = new Set<NodeJS.Timeout>();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const store = new Map<string, RateLimitEntry>();
  const max = positiveInteger(process.env[`RATE_LIMIT_${options.name}_MAX`], options.max);
  const windowMs = positiveInteger(process.env[`RATE_LIMIT_${options.name}_WINDOW_MS`], options.windowMs);
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) if (entry.resetAt <= now) store.delete(key);
  }, Math.max(windowMs, 60_000));
  timer.unref();
  cleanupTimers.add(timer);

  return (req: Request, res: Response, next: NextFunction) => {
    const key = options.key?.(req) ?? clientKey(req);
    const now = Date.now();
    const current = store.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };
    store.set(key, entry);

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ ok: false, reason: "rate_limited", error: options.message, retryAfterSeconds });
      return;
    }
    next();
  };
}

export function stopRateLimitCleanup(): void {
  for (const timer of cleanupTimers) clearInterval(timer);
  cleanupTimers.clear();
}
