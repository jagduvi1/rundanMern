# GameDo (MERN)

**GameDo** is a private, mobile-first web app for running group party games together, with a
**live shared scoreboard** that updates in real time as answers and scores come in. It's a
**MERN-stack port** of [Rundan](https://github.com/jagduvi1/rundan) (the original .NET app).

The original is a .NET 10 / Blazor WebAssembly / SignalR / SQLite app (~22k LOC). This repo rebuilds
it on the **same stack and conventions as [Glosan](https://github.com/jagduvi1/glosan)**:

| Concern | Technology |
|---|---|
| Database | **MongoDB** via Mongoose |
| API | **Express** (Node, CommonJS) |
| Realtime | **Socket.IO** (replaces SignalR) |
| Client | **React 19 + Vite** (replaces Blazor WASM) |
| Maps | **Leaflet + OpenStreetMap** (free, no API key) |
| Auth | **Hybrid** — JWT host/admin accounts + anonymous per-activity player tokens |
| Hosting | **Docker Compose** (Mongo + Express backend + nginx-served frontend) |

## Games

Built around two reusable building blocks (**questions+answers** and **score entries**) plus
game-specific logic:

- **Quiz** — classic sit-down quiz, question by question
- **Tipspromenad** — geo-located quiz walk; questions placed on a map, unlock + buzz on arrival
- **Boule** — round-based scoring **and** knockout/bracket tournaments (optional round-robin group stage → Playoff A/B)
- **Score game** — generic round-based scoring (points / time / millimetres; higher / lower / closest-to-target)
- **Word game** — flip letter tiles, form the longest word against a timer
- **Map-pin** — drop a pin on a label-free map per drawn city; lowest total distance wins
- **Music quiz** — host plays a Spotify track per question; players name song + artist (+ optional year, Kahoot-style speed scoring)
- **Memory** — each team races its own shuffled board of matching pairs (time/flips = score)

…plus multi-activity **events** with combined standings, the **"slap"** twist (winners halve a rival's
lead), event **group chat**, **spectators**, **web-push** notifications, a shared **photo wall**, and a
reusable **question library** (1052 seeded questions).

## Project structure

```
backend/                Express API + Socket.IO + Mongoose
  server.js             boot: validate env, connect Mongo, seed library, start http+socket
  src/
    app.js              middleware + route mounting
    config/             env (RundanOptions equivalent), db, paths
    constants/          enums (exact integer codes), socket event names
    models/             20 Mongoose models (18 collections + embedded subdocs)
    middleware/         JWT auth, access gate, participant + event/activity authorization, errors
    services/           scoring, scoreboard, standings, teams, bracket, wordgame, slap,
                        simulation, question library, geo, spotify, lastfm, musicLookup, push, …
    routes/             16 route modules (auth, events, activities, questions, gameplay, …)
    socket/             socket.io server + emit helpers
    data/               question-library.json (seed)
  scripts/seedLibrary.js
frontend/               React 19 + Vite SPA
  src/
    api/                one thin module per backend route group (token-aware client)
    config/             enums + socket event mirrors
    contexts/           AuthContext (host accounts), BootstrapContext (config + access gate)
    components/         play components + editors + shared UI (Scoreboard, QuizPlay, MapView, …)
    pages/              Home, Events, Event, Activity (gameplay router), Admin, Users, …
    utils/              socket client, interop hooks (geo, vibration, push, spotify)
docker-compose.yml      mongo + backend + frontend
```

## Auth model (hybrid)

- **Hosts/admins** register real accounts (`/api/auth/*`): JWT access token in memory + httpOnly refresh
  cookie with rotation/replay-detection. The **first account to register becomes the super-admin**.
  Per-event management is granted by **ownership** on the event (or the global `admin` role).
- **Players** stay anonymous: on join they get an opaque per-activity token, stored in `localStorage`
  and sent as `x-rundan-participant`. No signup — scan a code, type a name, play.
- An optional `ACCESS_CODE` env can gate a whole private deployment (timing-safe compared).

## Run it

### Docker (everything)

```bash
cp .env.example .env          # set a strong JWT_SECRET (>=32 chars)
docker compose up --build     # → http://localhost:8080
```

### Local dev

```bash
# 1. MongoDB (any instance), e.g.:
docker run -d -p 27017:27017 --name rundan-mongo mongo:7

# 2. Backend (port 5000)
cd backend && npm install
printf 'NODE_ENV=development\nPORT=5000\nMONGO_URI=mongodb://localhost:27017/rundan\nJWT_SECRET=dev-only-change-me-to-32+-random-chars-xx\n' > .env
npm run dev

# 3. Frontend (port 3000, proxies /api → :5000)
cd frontend && npm install
npm run dev                   # → http://localhost:3000
```

Open http://localhost:3000, register a host account (the first one is admin), create an event and
activities, then share the join code. The question library seeds automatically on first backend boot.

## Configuration

See [`.env.example`](.env.example). Required: `JWT_SECRET`. Optional integrations degrade gracefully
when unset: Spotify (`SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`), Last.fm (`LASTFM_API_KEY`),
Web Push (`VAPID_*`), email (`MAILGUN_API_KEY` + `MAILGUN_DOMAIN`), shared site gate (`ACCESS_CODE`).

## Notes on the port

- Enum **integer codes** are preserved exactly from the .NET app (e.g. `ActivityType.Quiz = 1`).
- EF relational tables → Mongoose: small ordered config lists (courts, map cities, memory cards,
  answer options, team members) are **embedded subdocuments**; large/independently-queried sets stay
  as referenced collections. There's **no DB cascade** in Mongo, so every EF `OnDelete(Cascade)` is
  replicated in `services/cascade.js`.
- SignalR's strongly-typed hub → Socket.IO with shared event-name constants (event name == method name).
- Several DTOs deliberately strip secrets (answer keys while live, Spotify tokens, real map-pin coords
  until pinned) via the `services/serializers.js` layer — routes never return raw Mongoose docs.

## License

MIT. The original Rundan app is by [@jagduvi1](https://github.com/jagduvi1).
