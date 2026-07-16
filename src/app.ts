import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import adminRouter from "./routes/admin";
import adminYoutubeRouter from "./routes/adminYoutube";
import answerRouter from "./routes/answer";
import contentAdminRouter from "./routes/content";
import diagnosticsRouter from "./routes/diagnostics";
import eventsRouter from "./routes/events";
import healthRouter from "./routes/health";
import leaderboardRouter from "./routes/leaderboard";
import registerRouter from "./routes/register";
import { adminReleasesRouter, releasesRouter } from "./routes/releases";
import roomsRouter from "./routes/rooms";
import stateRouter from "./routes/state";
import topicsRouter from "./routes/topics";
import { getStatus } from "./engine/roundController";
import { allowedOrigins } from "./config/cors";

type HttpError = Error & { statusCode?: number };

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    const error = new Error("Origin not allowed") as HttpError;
    error.statusCode = 403;
    callback(error);
  },
  credentials: false,
};

export function createApp(): express.Application {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    const requestId = req.get("x-request-id")?.slice(0, 100) || randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "64kb" }));

  app.use("/health", healthRouter);
  app.use("/diagnostics", diagnosticsRouter);
  app.use("/state", stateRouter);
  app.use("/events", eventsRouter);
  app.use("/answer", answerRouter);
  app.use("/register", registerRouter);
  app.use("/rooms", roomsRouter);
  app.use("/leaderboard", leaderboardRouter);
  app.use("/topics", topicsRouter);
  app.use("/releases", releasesRouter);
  app.use("/admin", adminRouter);
  app.use("/admin/releases", adminReleasesRouter);
  app.use("/admin/youtube", adminYoutubeRouter);
  app.use("/admin", contentAdminRouter);

  app.get("/", (_req, res) => {
    res.json({
      name: "Apologia Sancta Engine",
      version: process.env.npm_package_version ?? "1.0.0",
      endpoints: {
        health: "GET /health",
        diagnostics: "GET /diagnostics",
        state: "GET /state?roomId=...",
        events: "GET /events?roomId=...&userId=...",
        answer: "POST /answer",
        register: "POST /register",
        rooms: "GET /rooms",
        leaderboard: "GET /leaderboard?period=all-time|daily|weekly",
        topics: "GET /topics",
        releases: "GET /releases",
      },
      controller: getStatus(),
    });
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: "Route not found", path: req.path });
  });

  app.use((err: HttpError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = Number.isInteger(err.statusCode) ? err.statusCode! : 500;
    console.error("[RequestError]", { statusCode, message: err.message, requestId: res.getHeader("X-Request-Id") });
    res.status(statusCode).json({
      ok: false,
      error: statusCode >= 500 && process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
      requestId: res.getHeader("X-Request-Id"),
    });
  });
  return app;
}

export { allowedOrigins } from "./config/cors";
