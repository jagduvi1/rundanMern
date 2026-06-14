# Rundan (MERN)

A **MERN-stack port** of [Rundan](https://github.com/jagduvi1/rundan) — a private, mobile-first
web app for running group party games together, with a **live shared scoreboard**:

- **Quiz** — classic sit-down quiz, question by question
- **Tipspromenad** — geo-located quiz walk; questions unlock as you reach them on a map
- **Boule** — round scoring *and* knockout/bracket tournaments (with optional group stage)
- **Score game** — generic round-based scoring (points / time / length)
- **Word game**, **Map-pin**, **Music quiz** (Spotify), **Memory** — and more

The original is a .NET 10 / Blazor WebAssembly / SignalR / SQLite app. This repo rebuilds it on
the **same stack and conventions as [Glosan](https://github.com/jagduvi1/glosan)**:

| Concern | Technology |
|---|---|
| Database | **MongoDB** via Mongoose |
| API | **Express** (Node) |
| Realtime | **Socket.IO** (replaces SignalR) |
| Client | **React 19 + Vite** (replaces Blazor WASM) |
| Auth | **Hybrid** — JWT host/admin accounts + anonymous per-activity player tokens |
| Hosting | Docker Compose (Mongo + backend + nginx frontend) |

> 🚧 **Work in progress.** The backend foundation (models, auth, realtime, services) is landing
> first; routes and the React frontend follow.

## Layout

```
backend/    Express API + Socket.IO + Mongoose models + services
frontend/   React + Vite SPA            (coming)
docker-compose.yml                       (coming)
```

## Local development (backend)

```bash
cd backend
npm install
cp ../.env.example .env     # then set JWT_SECRET (>=32 chars) and MONGO_URI
npm run dev                 # nodemon on http://localhost:5000
```

Requires a running MongoDB (e.g. `docker run -p 27017:27017 mongo:7`).

## Auth model

- **Hosts/admins** register real accounts (`/api/auth/*`, JWT access token + httpOnly refresh
  cookie). The first account to register becomes the super-admin.
- **Players** stay anonymous: on join they receive an opaque per-activity token, persisted in the
  browser and sent as `x-rundan-participant`. No signup — scan a code, type a name, play.
- An optional `ACCESS_CODE` can gate a whole private deployment.

## License

MIT.
