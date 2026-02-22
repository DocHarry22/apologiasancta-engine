/**
 * Express Application Setup
 *
 * Configures middleware, CORS, and routes.
 */

import express from "express";
import cors from "cors";

import healthRouter from "./routes/health";
import stateRouter from "./routes/state";
import eventsRouter from "./routes/events";
import answerRouter from "./routes/answer";
import adminRouter from "./routes/admin";
import adminYoutubeRouter from "./routes/adminYoutube";
import { getStatus } from "./engine/roundController";

/**
 * Parse ALLOWED_ORIGIN env var as comma-separated list
 */
function parseAllowedOrigins(): string[] {
  const origins: string[] = [
    "http://localhost:3000",
    "http://localhost:3001", // Fallback port when 3000 is in use
    "http://localhost:5173",
    "http://127.0.0.1:3000",
  ];

  const envOrigins = process.env.ALLOWED_ORIGIN;
  if (envOrigins) {
    const parsed = envOrigins
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    origins.push(...parsed);
  }

  return origins;
}

const allowedOrigins = parseAllowedOrigins();

/**
 * CORS configuration
 * - Simple CORS without credentials for EventSource compatibility
 * - Uses allowlist from ALLOWED_ORIGIN env var
 */
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, mobile apps, etc.)
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: false, // EventSource doesn't need credentials
};

/**
 * Create and configure Express application
 */
export function createApp(): express.Application {
  const app = express();

  // Log allowed origins for debugging
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log("[Config] Allowed origins:", allowedOrigins.join(", "));
  }

  // Middleware
  app.use(cors(corsOptions));
  app.use(express.json());

  // Routes
  app.use("/health", healthRouter);
  app.use("/state", stateRouter);
  app.use("/events", eventsRouter);
  app.use("/answer", answerRouter);
  app.use("/admin", adminRouter);
  app.use("/admin/youtube", adminYoutubeRouter);

  // Root endpoint - API info
  app.get("/", (_req, res) => {
    const status = getStatus();
    res.json({
      name: "Apologia Sancta Engine",
      version: "1.0.0",
      endpoints: {
        health: "GET /health - Health check",
        state: "GET /state - Current quiz state",
        events: "GET /events - SSE stream",
        answer: "POST /answer - Submit answer",
        admin: "POST /admin/* - Admin controls (requires x-admin-token)",
        youtube: "POST /admin/youtube/* - YouTube Live Chat integration (requires x-admin-token)",
      },
      controller: status,
    });
  });

  // Error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error("[Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  );

  return app;
}

// Export allowed origins for logging
export { allowedOrigins };
