# Apologia Sancta Engine

Backend runtime for Apologia Sancta Live, a room-aware theology battle trivia platform with SSE delivery, mobile and YouTube answer ingestion, leaderboard windows, and restart-safe runtime persistence.

Deployed on Render: `https://apologiasancta-engine.onrender.com`

## Operational security update (July 2026)

The production blueprint now uses PostgreSQL atomic runtime snapshots and no longer provisions an unused Redis service. Player registration issues an HMAC-signed, expiring room token; join, leave, rename and answer routes enforce that identity, while expired signed sessions may be refreshed by rejoining. Production also has strict origin resolution, request/player rate limits, request IDs, bounded bodies and a non-secret `/diagnostics` readiness endpoint.

`ADMIN_TOKEN` and the independent `PLAYER_JOIN_SECRET` are required in production. Configure the latter on Render before deploying this branch. The coordinated UI repository contains the full [production runbook](https://github.com/DocHarry22/apologiasancta-ui/blob/feature/apologia-operational-platform/docs/PRODUCTION_RUNBOOK.md).

## Current State (v1 — May 2026)

The engine is live on Render and serving production traffic. All core game mechanics are operational.

**What's working:**
- Multi-room battle trivia with a pinned `global` room and admin-created player rooms
- Room-scoped memberships, answers, scores, streaks, and leaderboard views
- Global player identity preserved across room switches
- SSE streams delivering real-time round state to rooms and individual players
- Time-based scoring with difficulty multipliers and streak tracking
- Daily, weekly, and all-time leaderboard windows
- YouTube Live Chat polling for `!A` / `!B` / `!C` / `!D` answers
- Restart recovery restoring the checkpoint in **paused** mode (no mid-round auto-resume)
- Runtime persistence: JSON-file (default) and experimental SQLite backend (`STATE_PERSISTENCE_DRIVER=sqlite`)
- CI pipeline on GitHub Actions: Node 22 typecheck, tests, and build on every push

**Known limitations:**
- Topic-flow sequencing is still **shared engine-wide** — per-room topic progression isolation is not yet complete
- Postgres and Redis production adapters are scaffolded in `render.yaml` but not yet wired into live state management; the engine runs on a single Render instance using file-backed persistence
- SQLite backend emits a Node experimental warning on Node 22

## Future Goals

- **Per-room topic flow** — isolate topic-sequence ordering and repeat counters per room so rooms can run independent question tracks simultaneously
- **Postgres/Redis runtime adapters** — wire the provisioned Render Postgres and Redis services into the persistence and SSE layers to enable multi-instance horizontal scaling
- **Nonce-based CSP** — eliminate `unsafe-inline` from script delivery once Next.js nonce support is stable
- **Signed APK CI pipeline** — verify and enable the GitHub Actions signed APK/AAB release workflow end-to-end
- **Graceful drain** — allow in-flight SSE connections to complete before a Render deployment replaces the instance

## Features

- Multi-room battle trivia runtime with a pinned global room plus admin-created player rooms
- SSE streams for global, personalized, and room-specific state delivery
- Room-scoped leaderboard endpoints for `daily`, `weekly`, and `all-time`
- Time-based scoring with difficulty multipliers and streak tracking
- Runtime persistence for content, room registry, memberships, players, score history, and controller checkpoints
- Restart restore that clears transient congrats/countdown transitions and waits for an admin resume
- YouTube Live Chat polling for `!A`, `!B`, `!C`, and `!D` answers
- Content/topic management endpoints used by the authoring UI
- Backend verification suite runnable with `npm test`

## Architecture

```
YouTube Live Chat                  Mobile / UI clients
       │                                   │
       ▼                                   ▼
┌───────────────────────────────────────────────────────────────┐
│ Express routes                                                │
│  /events   /state   /register   /answer   /rooms   /admin     │
├───────────────────────────────────────────────────────────────┤
│ Shared round controller                                        │
│  OPEN -> LOCKED -> REVEAL                                      │
│  shared topic flow across active rooms                         │
├───────────────────────────────────────────────────────────────┤
│ Room-aware runtime state                                       │
│  rooms  memberships  players  scores  streaks  leaderboard     │
├───────────────────────────────────────────────────────────────┤
│ Persistence snapshot                                           │
│  content bank  pools  topic sequence  checkpoints  score log   │
└───────────────────────────────────────────────────────────────┘
```

## Setup

### Prerequisites

- Node.js 18+ for file-backed persistence
- Node.js 22+ to use the built-in SQLite persistence driver
- npm

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env` file:

```env
# Server
PORT=4000

# CORS
CORS_ORIGINS=http://localhost:3000,https://your-domain.com
ALLOW_LOCAL_ORIGINS=false

# Admin
ADMIN_TOKEN=your-secure-admin-token

# Public player room sessions (use a different high-entropy value)
PLAYER_JOIN_SECRET=your-secure-player-join-secret

# YouTube integration (optional)
YOUTUBE_API_KEY=AIza...your_key
YOUTUBE_VIDEO_ID=optional_default_video_id

# Phase durations in seconds
OPEN_SECONDS=25
LOCK_SECONDS=2
REVEAL_SECONDS=12

# Runtime persistence (PostgreSQL is recommended in production)
# Default file-backed snapshot storage
STATE_FILE_PATH=./data/runtime-state.json

# Optional database-backed snapshot storage
# If STATE_DB_PATH is set, sqlite mode is selected automatically unless overridden.
STATE_PERSISTENCE_DRIVER=sqlite
STATE_DB_PATH=./data/runtime-state.sqlite

# Managed PostgreSQL snapshot persistence
STATE_PERSISTENCE_DRIVER=postgres
DATABASE_URL=postgresql://...
```

### Running

```bash
# Development
npm run dev

# Verification
npm test

# Production
npm run build
npm start
```

## Public API

### Core state and events

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Service health, room counts, and persistence status |
| `/diagnostics` | GET | Non-secret deployment readiness and version metadata |
| `/state` | GET | Shared live state |
| `/state/:roomId` | GET | Room-scoped live state |
| `/events` | GET | Shared SSE stream |
| `/events/:roomId` | GET | Room-specific SSE stream |

### Players and answers

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/register` | POST | Register a player in the default flow |
| `/register/me` | GET | Resolve a player and auto-rejoin their room |
| `/register/rank` | GET | Player rank snapshot |
| `/register/check` | GET | Username availability check |
| `/answer` | POST | Submit answer on the shared route |
| `/answer/:roomId` | POST | Submit answer for a room |

### Rooms and leaderboards

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/rooms` | GET | List rooms |
| `/rooms/:roomId` | GET | Room summary |
| `/rooms/:roomId/join` | POST | Join an active room |
| `/rooms/:roomId/leave` | POST | Leave a room |
| `/rooms/:roomId/state` | GET | Room-scoped state snapshot |
| `/rooms/:roomId/events` | GET | Room-scoped SSE stream |
| `/rooms/:roomId/register` | POST | Register directly into a room |
| `/rooms/:roomId/answer` | POST | Submit room-scoped answer |
| `/leaderboard?period=all-time\|daily\|weekly` | GET | Global leaderboard snapshot |
| `/rooms/:roomId/leaderboard?period=all-time\|daily\|weekly` | GET | Room leaderboard snapshot |

### Content browsing

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/topics` | GET | List available topics |
| `/topics/:topicId` | GET | Topic details |

## Admin API

All admin endpoints require the `x-admin-token` header.

### Engine-wide controls

- `POST /admin/start`
- `POST /admin/resume`
- `POST /admin/pause`
- `POST /admin/next`
- `POST /admin/reset`
- `GET /admin/status`
- `POST /admin/persistence/save`
- `GET /admin/rooms`
- `POST /admin/rooms`

### Room-scoped controls

- `POST /admin/rooms/:roomId/start`
- `POST /admin/rooms/:roomId/resume`
- `POST /admin/rooms/:roomId/pause`
- `POST /admin/rooms/:roomId/next`
- `POST /admin/rooms/:roomId/reset`
- `GET /admin/rooms/:roomId/status`
- `POST /admin/rooms/:roomId/close`

### Topic and countdown controls

Both engine-wide and room-scoped variants exist for:

- topic start / next / skip / replay / countdown
- topic sequence reads and updates
- topic loop and series loop settings
- countdown duration overrides
- cancel-auto topic transitions

### YouTube controls

- `POST /admin/youtube/connect`
- `POST /admin/youtube/disconnect`
- `GET /admin/youtube/status`

## Persistence Model

Runtime snapshots include:

- content bank and active question pool order
- topic-sequence configuration
- controller checkpoints
- room registry and memberships
- players, room scores, room streaks, and score event history

On restart, the engine restores the current checkpoint in paused mode. It does not auto-resume timers mid-round.

### Persistence Drivers

- `file` stores the runtime snapshot as formatted JSON at `STATE_FILE_PATH`
- `sqlite` stores the same runtime snapshot atomically in a local SQLite database at `STATE_DB_PATH`
- `postgres` stores the snapshot atomically in `runtime_state_snapshots` using `DATABASE_URL`

If `STATE_PERSISTENCE_DRIVER` is unset and `STATE_DB_PATH` is present, the engine automatically uses the SQLite driver.

## Verification

`npm test` runs the backend verification suite covering:

- room-scoped leaderboard windows and weekly rollover behavior
- room lifecycle and closed-room gameplay rejection
- SSE partitioning between rooms
- persistence restore behavior and paused checkpoint recovery

`npx tsc --noEmit` is also expected to pass for the engine workspace.

## YouTube Flow

1. Set `YOUTUBE_API_KEY`.
2. Connect a live stream with `POST /admin/youtube/connect`.
3. Start or resume gameplay from the admin API.
4. Poller messages containing `!A`, `!B`, `!C`, or `!D` are mapped to stable player IDs in the form `yt:<channelId>`.

## Project Structure

```
src/
├── app.ts                  # Express app wiring
├── backend.verification.test.ts
├── config/                 # Topic sequencing configuration
├── content/                # Question bank and validation
├── engine/                 # Round controller and scoring
├── github/                 # GitHub-backed content helpers
├── routes/                 # Public and admin HTTP routes
├── sse/                    # SSE broker
├── state/                  # Rooms, players, persistence, store
├── testSupport/            # Test utilities
├── types/                  # Shared runtime types
└── youtube/                # YouTube client, parser, poller
```

## License

ISC
