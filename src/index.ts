/**
 * Apologia Sancta Engine - Entry Point
 */

import "dotenv/config";
import { createApp, allowedOrigins } from "./app";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const OPEN_SECONDS = process.env.OPEN_SECONDS || "25";
const LOCK_SECONDS = process.env.LOCK_SECONDS || "2";
const REVEAL_SECONDS = process.env.REVEAL_SECONDS || "12";

const app = createApp();

app.listen(PORT, () => {
  const ytConfigured = process.env.YOUTUBE_API_KEY ? "✓" : "✗";
  console.log(`
╔═══════════════════════════════════════════════════════╗
║     Apologia Sancta Engine v1.0                       ║
║     Running on http://localhost:${PORT}                  ║
╠═══════════════════════════════════════════════════════╣
║  Endpoints:                                           ║
║    GET  /health    - Health check                     ║
║    GET  /state     - Current quiz state               ║
║    GET  /events    - SSE stream                       ║
║    POST /answer    - Submit answer                    ║
║    POST /admin/*   - Admin controls                   ║
║    POST /admin/youtube/* - YouTube chat (${ytConfigured} API key)     ║
╠═══════════════════════════════════════════════════════╣
║  Phase Durations:                                     ║
║    OPEN: ${OPEN_SECONDS.padStart(2)}s   LOCK: ${LOCK_SECONDS.padStart(2)}s   REVEAL: ${REVEAL_SECONDS.padStart(2)}s           ║
╚═══════════════════════════════════════════════════════╝
  `);
  console.log(`[Config] Allowed origins: ${allowedOrigins.join(", ")}`);
  console.log(`[Config] Use POST /admin/start to begin the quiz`);
});
