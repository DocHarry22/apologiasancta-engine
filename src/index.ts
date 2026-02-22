/**
 * Apologia Sancta Engine - Entry Point
 */

import "dotenv/config";
import { createApp, allowedOrigins } from "./app";
import { syncFromGitHub, getSyncStatus, getGitHubSyncConfig } from "./content/github";
import { getScoringMode } from "./engine/scoring";

const port = Number(process.env.PORT ?? 4000);
const host = "0.0.0.0";
const OPEN_SECONDS = process.env.OPEN_SECONDS || "25";
const LOCK_SECONDS = process.env.LOCK_SECONDS || "2";
const REVEAL_SECONDS = process.env.REVEAL_SECONDS || "12";

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
    } else {
      console.warn(`[Startup] Sync completed with ${result.errors.length} errors`);
      result.errors.forEach((e) => console.warn(`  - ${e}`));
    }
  } catch (err) {
    console.error("[Startup] Auto-sync failed:", err);
  }
}

app.listen(port, host, () => {
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
  console.log(`[Config] Use POST /admin/start to begin the quiz`);

  // Auto-sync from GitHub after server starts
  autoSync();
});
