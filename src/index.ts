/**
 * Apologia Sancta Engine - Entry Point
 */

import "dotenv/config";
import type { Server } from "http";
import { createApp, allowedOrigins } from "./app";
import { syncFromGitHub, getSyncStatus, getGitHubSyncConfig } from "./content/github";
import { getContentBankPersistenceSnapshot, hydrateContentBankPersistenceSnapshot } from "./content/bank";
import {
  getTopicSequencePersistenceSnapshot,
  hydrateTopicSequencePersistenceSnapshot,
} from "./config/topicSequence";
import {
  getControllerPersistenceSnapshot,
  hydrateControllerPersistenceSnapshot,
  startAutomaticQuizRuntime,
} from "./engine/roundController";
import { getScoringMode } from "./engine/scoring";
import { getPlayersPersistenceSnapshot, hydratePlayersPersistenceSnapshot } from "./state/players";
import {
  configureStatePersistence,
  getPersistenceStatus,
  getStatePersistencePath,
  restorePersistedState,
  shutdownPersistence,
} from "./state/persistence";
import { getRoomsPersistenceSnapshot, hydrateRoomsPersistenceSnapshot } from "./state/rooms";
import { stopRateLimitCleanup } from "./routes/register";
import { assertProductionJoinSecret } from "./security/joinToken";
import { assertAccountIdentityConfiguration } from "./security/accountIdentity";

const port = Number(process.env.PORT ?? 4000);
const host = "0.0.0.0";
const OPEN_SECONDS = process.env.OPEN_SECONDS || "25";
const LOCK_SECONDS = process.env.LOCK_SECONDS || "2";
const REVEAL_SECONDS = process.env.REVEAL_SECONDS || "12";

if (process.env.NODE_ENV === "production") {
  const missing = ["ADMIN_TOKEN"].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required production configuration: ${missing.join(", ")}`);
  }
  assertProductionJoinSecret();
}
// The opt-in exchange must fail fast in every environment when enabled with an
// invalid or reused key. When disabled, this is intentionally a no-op.
assertAccountIdentityConfiguration();

let server: Server | null = null;
let shuttingDown = false;

configureStatePersistence({
  getSnapshot: () => ({
    content: getContentBankPersistenceSnapshot(),
    topicSequence: getTopicSequencePersistenceSnapshot(),
    controller: getControllerPersistenceSnapshot(),
    rooms: getRoomsPersistenceSnapshot(),
    players: getPlayersPersistenceSnapshot(),
  }),
  applySnapshot: (snapshot) => {
    hydrateContentBankPersistenceSnapshot(snapshot.content as ReturnType<typeof getContentBankPersistenceSnapshot>);
    hydrateTopicSequencePersistenceSnapshot(snapshot.topicSequence as ReturnType<typeof getTopicSequencePersistenceSnapshot>);
    hydrateRoomsPersistenceSnapshot(snapshot.rooms as ReturnType<typeof getRoomsPersistenceSnapshot>);
    hydratePlayersPersistenceSnapshot(snapshot.players as ReturnType<typeof getPlayersPersistenceSnapshot>);
    hydrateControllerPersistenceSnapshot(snapshot.controller as ReturnType<typeof getControllerPersistenceSnapshot>);
  },
});

const app = createApp();

// Auto-sync from GitHub on startup if configured
async function autoSync() {
  const config = getGitHubSyncConfig();
  if (!config) {
    console.log(
      "[Startup] GitHub not configured. Set GITHUB_OWNER/GITHUB_REPO (or GITHUB_CONTENT_OWNER/GITHUB_CONTENT_REPO) to enable auto-sync."
    );
    console.log("[Startup] Engine bank is empty. Use POST /admin/content/import to load questions.");
    return;
  }

  console.log(
    `[Startup] GitHub repo: ${config.owner}/${config.repo} (branch: ${config.branch}, path: ${config.contentPath})`
  );

  console.log("[Startup] Auto-syncing from GitHub...");
  try {
    const result = await syncFromGitHub();
    if (result.success) {
      console.log(`[Startup] Synced ${result.questionsLoaded} questions from ${result.topicsLoaded} topics`);
      const synchronizedRooms = startAutomaticQuizRuntime();
      if (synchronizedRooms.length > 0) {
        console.log(`[Startup] Applied automatic quiz runtime after content sync: ${synchronizedRooms.join(", ")}`);
      }
    } else {
      console.warn(`[Startup] Sync completed with ${result.errors.length} errors`);
      result.errors.forEach((e) => console.warn(`  - ${e}`));
    }
  } catch (err) {
    console.error("[Startup] Auto-sync failed:", err);
  }
}

async function main() {
  const restored = await restorePersistedState();
  const automaticRooms = startAutomaticQuizRuntime();
  if (automaticRooms.length > 0) {
    console.log(
      `[Startup] Automatic quiz runtime started for ${automaticRooms.length} room(s) after ${restored ? "persistence restore" : "fresh initialization"}: ${automaticRooms.join(", ")}`
    );
  }

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[Shutdown] Received ${signal}; flushing runtime state...`);

    stopRateLimitCleanup();

    try {
      await shutdownPersistence();
      console.log("[Shutdown] Runtime state flushed");
    } catch (error) {
      console.error("[Shutdown] Failed to flush runtime state:", error);
    }

    if (!server) {
      process.exit(0);
      return;
    }

    server.close((error) => {
      if (error) {
        console.error("[Shutdown] Failed to close server cleanly:", error);
        process.exit(1);
        return;
      }

      process.exit(0);
    });

    setTimeout(() => {
      console.error("[Shutdown] Forced exit after timeout");
      process.exit(1);
    }, 10000).unref();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  server = app.listen(port, host, () => {
    const ytConfigured = process.env.YOUTUBE_API_KEY ? "✓" : "✗";
    const ghConfigured = getGitHubSyncConfig() ? "✓" : "✗";
    const scoringMode = getScoringMode();
    console.log(`
╔═══════════════════════════════════════════════════════╗
║     Apologia Sancta Engine v1.0                       ║
║     Listening on ${host}:${port}                         ║
╠═══════════════════════════════════════════════════════╣
║  Endpoints:                                           ║
║    GET  /health    - Health check                     ║
║    GET  /state     - Current quiz state               ║
║    GET  /events    - SSE stream                       ║
║    GET  /topics    - Public content (from GitHub)     ║
║    POST /answer    - Submit answer                    ║
║    POST /admin/*   - Admin controls                   ║
║    POST /admin/youtube/* - YouTube chat (${ytConfigured} API key)     ║
║    POST /admin/content/sync - Sync from GitHub (${ghConfigured})     ║
╠═══════════════════════════════════════════════════════╣
║  Phase Durations:                                     ║
║    OPEN: ${OPEN_SECONDS.padStart(2)}s   LOCK: ${LOCK_SECONDS.padStart(2)}s   REVEAL: ${REVEAL_SECONDS.padStart(2)}s           ║
║  Scoring: ${scoringMode.padEnd(43)}║
╚═══════════════════════════════════════════════════════╝
  `);
    console.log(`[Config] Allowed origins: ${allowedOrigins.join(", ")}`);
    console.log(`[Config] Runtime persistence: ${getPersistenceStatus().driver} @ ${getStatePersistencePath()}`);
    console.log("[Config] Use POST /admin/persistence/save to force a runtime snapshot");
    console.log(
      automaticRooms.length > 0
        ? `[Config] Automatic quiz runtime active for: ${automaticRooms.join(", ")}`
        : "[Config] Use POST /admin/start to begin the quiz"
    );

    // Auto-sync from GitHub after server starts
    autoSync();
  });
}

main().catch((error) => {
  console.error("[Startup] Failed to initialize engine:", error);
  process.exitCode = 1;
});
