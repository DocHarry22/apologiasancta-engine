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
import contentAdminRouter from "./routes/content";
import registerRouter from "./routes/register";
import topicsRouter from "./routes/topics";
import roomsRouter from "./routes/rooms";
import leaderboardRouter from "./routes/leaderboard";
import { getStatus } from "./engine/roundController";

/**
 * Parse ALLOWED_ORIGIN env var as comma-separated list
 */
function parseAllowedOrigins(): string[] {
  const isDev = process.env.NODE_ENV !== "production";
  const localDevOrigins = [
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
  const productionOrigins = [
    "https://sandybrown-bear-488955.hostingersite.com",
    "https://apologiasancta-ui.onrender.com",
  ];
  const includeLocalOrigins = isDev || process.env.ALLOW_LOCAL_ORIGINS !== "false";
  const origins = new Set<string>([
    ...productionOrigins,
    ...(includeLocalOrigins ? localDevOrigins : []),
  ]);

  const envOrigins = process.env.ALLOWED_ORIGIN;
  if (envOrigins) {
    const parsed = envOrigins
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    for (const origin of parsed) {
      origins.add(origin);
    }
  }

  if (!isDev && origins.size === 0) {
    console.warn("[Config] No ALLOWED_ORIGIN values configured in production; browser clients will be blocked by CORS.");
  }

  return [...origins];
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
  app.use("/register", registerRouter);
  app.use("/rooms", roomsRouter);
  app.use("/leaderboard", leaderboardRouter);
  app.use("/topics", topicsRouter); // Public content browsing
  app.use("/admin", adminRouter);
  app.use("/admin/youtube", adminYoutubeRouter);
  app.use("/admin", contentAdminRouter); // Content management routes

  // Root endpoint - API info
  app.get("/", (_req, res) => {
    const status = getStatus();
    res.json({
      name: "Apologia Sancta Engine",
      version: "1.0.0",
      endpoints: {
        health: "GET /health - Health check",
        state: "GET /state - Current quiz state",
        events: "GET /events?userId=... - SSE stream (personalized if userId provided)",
        answer: "POST /answer - Submit answer",
        register: "POST /register - Register unique username, GET /me/:userId, GET /rank/:userId, POST /rename",
        rooms: "GET /rooms - List rooms, GET /rooms/:roomId - Room summary",
        leaderboard: "GET /leaderboard?period=all-time|daily|weekly - Global leaderboard, GET /rooms/:roomId/leaderboard - Room leaderboard",
        topics: "GET /topics - List topics with counts, GET /topics/:id - Topic details (public)",
        admin: "POST /admin/start|resume|pause|next|reset|persistence/save - Admin controls (requires x-admin-token)",
        youtube: "POST /admin/youtube/* - YouTube Live Chat integration (requires x-admin-token)",
        content: "POST /admin/content/* - Content management (requires x-admin-token)",
        quizSet: "POST /admin/quiz/set - Set active quiz pool (requires x-admin-token)",
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
