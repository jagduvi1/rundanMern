# CLAUDE.md — working notes for this repo

Gamedo (MERN) is a **port** of the .NET 10 / Blazor app *rundan* (https://github.com/jagduvi1/rundan)
onto the **Glosan** MERN stack (MongoDB + Express + React/Vite + Socket.IO). A private, mobile-first
party-games platform with a live shared scoreboard and ~8 game types. The product is branded **Gamedo**
(gamedo.app); internal wire/storage identifiers intentionally keep the legacy `rundan` token — see below.

## Stack & layout
- `backend/` — Express (CommonJS), Mongoose, Socket.IO. Entry `server.js` → `src/app.js`.
- `frontend/` — React 19 + Vite (ESM), react-router v6, socket.io-client. Entry `src/main.jsx` → `src/App.jsx`.
- `docker-compose.yml` — mongo:7 + backend + nginx-served frontend.

## Run / test
- Backend dev: `cd backend && npm run dev` (needs Mongo + a `.env` with `JWT_SECRET`, `MONGO_URI`, `PORT`).
- Frontend dev: `cd frontend && npm run dev` (port 3000, proxies `/api` → `localhost:5000`).
- Frontend build: `cd frontend && npx vite build`.
- The question library (1052 Qs) seeds automatically on first backend boot.
- `frontend/.npmrc` sets `legacy-peer-deps=true` (react-helmet-async's peer range predates React 19).

## Conventions that matter (don't break these)
- **Brand vs. legacy identifiers.** The product is branded **Gamedo** (gamedo.app) — all user-facing
  text, titles, and logo say so (`frontend/public/assets/gamedo-*.svg`). But on-the-wire and on-disk
  identifiers intentionally keep the legacy `rundan` token for backward compatibility: auth headers
  (`x-rundan-participant` / `x-rundan-member` / `x-rundan-access`), localStorage keys (`rundan.*`), the
  Mongo database name (`rundan`), and the `RUNDAN_HOST` env var. Do **not** rename these to `gamedo` —
  it would break existing sessions/data. Code comments that reference the upstream .NET repo `rundan`
  (`port of rundan's …`, `Rundan.Server/…`) are also intentional and accurate.
- **Enum integer codes are load-bearing on the wire** — kept identical to the .NET app in both
  `backend/src/constants/enums.js` and `frontend/src/config/enums.js`. `ActivityType` starts at **1**;
  all others at 0. Keep the two files in sync.
- **Socket event names == method names**, shared in `*/constants|config/socketEvents.js`. `EventChanged`
  payload is a **bare id string**, not an object.
- **Hybrid auth**: hosts = JWT accounts (`Account` model, `/api/auth/*`, refresh-token rotation);
  players = anonymous `Participant.token` (header `x-rundan-participant`); event co-hosts =
  `EventMember.token` (header `x-rundan-member`); optional shared `ACCESS_CODE` gate. `req.user` is
  populated on every route by global `optionalAuth`; `canManageEvent/canManageActivity` decide
  management rights (super-admin role, event ownership, or member-admin token).
- **`User` ≠ account.** `User` is a roster person (just a name); `Account` is the auth user. Don't merge.
- **No DB cascade.** Replicate deletes in `backend/src/services/cascade.js`. Embedded subdocs
  (Activity.courts/mapCities/memoryCards, Participant.members, Question.options, QuestionTemplate.options/tags)
  cascade automatically; everything else is explicit.
- **Serializers strip secrets.** Routes return DTOs via `backend/src/services/serializers.js`, never raw
  docs — answer keys are hidden while live, Spotify tokens never leave the server (`select:false`),
  map-pin coords are withheld until pinned.
- **Frontend API calls** go through `src/api/*` modules (token-aware `src/api/client.js`), never raw fetch.
- IDs are Mongo ObjectId hex **strings** on the wire; all DTO fields are **camelCase**.

## Reference
- `_port/analysis/*.md` (gitignored) — the implementation specs the port was built from (data model,
  endpoints, services, frontend). The original C# source is not in this repo.
- Integrations degrade gracefully when their env vars are unset (Spotify, Last.fm, web-push, email).
