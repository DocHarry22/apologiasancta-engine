# Apologia Sancta Engine

Backend engine for **Apologia Sancta Live** — a real-time theology quiz platform supporting YouTube Live Chat integration and mobile play.

## Features

- **Real-time Quiz Engine** — State machine controlling OPEN → LOCKED → REVEAL phases
- **YouTube Live Chat Integration** — Poll YouTube chat for `!A`, `!B`, `!C`, `!D` answers
- **Server-Sent Events (SSE)** — Real-time state broadcast to all connected clients
- **Unified Leaderboard** — Single scoreboard for YouTube + mobile players
- **Personalized SSE Streams** — Optional `?userId=` parameter for personal rank/score
- **Scoring System** — Time-based scoring with difficulty multipliers and streaks

## Architecture

```
YouTube Live Chat                Mobile /mobile
       │                              │
       ▼ (poll every 5-10s)           ▼ POST /answer
┌─────────────────────────────────────────────────────┐
│  YouTubePoller ──► players.submitAnswer() ◄────────┤
│                           │                         │
│                    players Map<userId, Player>      │
│                           │                         │
│                    ┌──────┴──────┐                  │
│                    ▼             ▼                  │
│             getTopScorers()  getTopStreaks()        │
│                    └──────┬──────┘                  │
│                           ▼                         │
│                    SSE broadcast()                  │
│                    ├─ /events (global)              │
│                    └─ /events?userId=... (personal) │
└─────────────────────────────────────────────────────┘
       │                              │
       ▼                              ▼
  OBS Overlay                   Mobile UI
```

## Setup

### Prerequisites

- Node.js 18+
- npm or yarn

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
ALLOWED_ORIGIN=http://localhost:3000,https://your-domain.com

# Admin
ADMIN_TOKEN=your-secure-admin-token

# YouTube Integration (optional)
YOUTUBE_API_KEY=AIza...your_key
YOUTUBE_VIDEO_ID=optional_default_video_id

# Phase Durations (seconds)
OPEN_SECONDS=25
LOCK_SECONDS=2
REVEAL_SECONDS=12
```

### Running

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

## API Endpoints

### Public

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/state` | GET | Current quiz state |
| `/events` | GET | SSE stream (global) |
| `/events?userId=...` | GET | SSE stream (personalized) |
| `/answer` | POST | Submit answer |
| `/register` | POST | Register username (mobile) |
| `/register/me?userId=...` | GET | Get player info |
| `/register/rank?userId=...` | GET | Get player rank |
| `/register/check?username=...` | GET | Check username availability |

### Admin (requires `x-admin-token` header)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/start` | POST | Start quiz |
| `/admin/pause` | POST | Pause quiz |
| `/admin/skip` | POST | Skip to next question |
| `/admin/reset` | POST | Reset all scores |
| `/admin/youtube/connect` | POST | Connect to YouTube live |
| `/admin/youtube/disconnect` | POST | Disconnect YouTube |
| `/admin/youtube/status` | GET | Get YouTube poller status |

## YouTube Integration

### How It Works

1. Connect to a YouTube live stream via `/admin/youtube/connect`
2. Engine polls YouTube Live Chat API every 5-10 seconds
3. Parses messages for `!A`, `!B`, `!C`, `!D` (case-insensitive)
4. Creates players with stable `userId = yt:<channelId>`
5. Handles username collisions with `#XXXX` suffix

### Go Live Checklist

```bash
# 1. Set YouTube API key
export YOUTUBE_API_KEY=AIza...

# 2. Connect to live stream
curl -X POST http://localhost:4000/admin/youtube/connect \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"videoId": "YOUR_VIDEO_ID"}'

# 3. Start quiz
curl -X POST http://localhost:4000/admin/start \
  -H "x-admin-token: $ADMIN_TOKEN"

# 4. Check status
curl http://localhost:4000/admin/youtube/status \
  -H "x-admin-token: $ADMIN_TOKEN"
```

## Quiz State

The engine broadcasts this state via SSE:

```typescript
interface QuizState {
  phase: "OPEN" | "LOCKED" | "REVEAL";
  endsAtMs: number;
  questionIndex: number;
  totalQuestions: number;
  themeTitle: string;
  question: {
    text: string;
    choices: Array<{ id: string; label: string; text: string }>;
    correctId?: string; // Only during REVEAL
  };
  leaderboard: {
    topScorers: Array<{ rank: number; name: string; score: number }>;
    topStreaks: Array<{ rank: number; name: string; streak: number }>;
  };
  teaching?: { title: string; body: string; refs: string[] };
  ticker?: { items: string[] };
  me?: PlayerInfo; // Only with ?userId= parameter
}
```

## Project Structure

```
src/
├── index.ts              # Entry point
├── app.ts                # Express app setup
├── content/
│   ├── questions.ts      # Legacy question bank
│   └── bank.ts           # Dynamic question pool
├── engine/
│   ├── roundController.ts # Phase state machine
│   └── scoring.ts        # Score calculation
├── routes/
│   ├── admin.ts          # Admin controls
│   ├── adminYoutube.ts   # YouTube management
│   ├── answer.ts         # Answer submission
│   ├── events.ts         # SSE endpoint
│   ├── health.ts         # Health check
│   ├── register.ts       # User registration
│   └── state.ts          # State endpoint
├── sse/
│   └── broker.ts         # SSE client management
├── state/
│   ├── players.ts        # Player data & scoring
│   └── store.ts          # State store
├── types/
│   └── quiz.ts           # TypeScript types
└── youtube/
    ├── client.ts         # YouTube API client
    ├── parser.ts         # Chat message parser
    └── poller.ts         # Live chat poller
```

## License

ISC
