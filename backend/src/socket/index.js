const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { ClientEvents, ServerEvents, activityRoom, eventRoom } = require('../constants/socketEvents');
const { socketAccessAllowed } = require('../middleware/accessGate');
const emit = require('./emit');

// Socket.IO server — the port of rundan's in-process SignalR ScoreboardHub.
// Handshake: enforce the optional access gate, then attach the host account if a
// JWT is supplied (players/viewers connect anonymously). Rooms map 1:1 with
// rundan's groups (`activity:{id}`, `event:{id}`); room membership is
// subscription, not authorization (writes re-check on the HTTP side).
function initSockets(httpServer) {
  const socketOrigin = (() => {
    const raw = env.frontendUrl;
    if (!raw) return env.isProd ? false : 'http://localhost:3000';
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length === 1 ? list[0] : list;
  })();

  const io = new Server(httpServer, {
    cors: { origin: socketOrigin, methods: ['GET', 'POST'] },
    path: '/api/socket.io',
  });

  io.use((socket, next) => {
    if (!socketAccessAllowed(socket.handshake)) return next(new Error('Invalid access code'));
    const token = socket.handshake.auth?.token;
    if (token) {
      try {
        const d = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
        socket.data.user = { id: d.id, roles: d.roles || ['user'] };
      } catch {
        socket.data.user = null;
      }
    } else {
      socket.data.user = null;
    }
    next();
  });

  // Live presence per event room: room → Map<socketId, { name }>. Lets the host see
  // which players currently have the app open (and who they're still waiting for).
  // In-memory + best-effort: a server restart just re-derives it as clients re-join.
  const eventPresence = new Map();
  const presenceNames = (room) => {
    const m = eventPresence.get(room);
    if (!m) return [];
    const byKey = new Map();
    for (const who of m.values()) if (who && who.name) byKey.set(who.name.toLowerCase(), who.name);
    return [...byKey.values()].sort((a, b) => a.localeCompare(b));
  };
  const emitPresence = (eventId) => {
    const room = eventRoom(eventId);
    io.to(room).emit(ServerEvents.PresenceChanged, { eventId: String(eventId), connected: presenceNames(room) });
  };

  io.on('connection', (socket) => {
    socket.on(ClientEvents.JoinActivity, (activityId) => {
      if (activityId != null) socket.join(activityRoom(activityId));
    });
    socket.on(ClientEvents.LeaveActivity, (activityId) => {
      if (activityId != null) socket.leave(activityRoom(activityId));
    });
    // JoinEvent accepts a bare eventId (legacy) or { eventId, who:{ name } } so a
    // logged-in player/host reports their identity for the host's presence list.
    socket.on(ClientEvents.JoinEvent, (arg) => {
      const eventId = arg && typeof arg === 'object' ? arg.eventId : arg;
      if (eventId == null) return;
      const room = eventRoom(eventId);
      socket.join(room);
      const name = arg && typeof arg === 'object' && arg.who && arg.who.name
        ? String(arg.who.name).slice(0, 60) : null;
      if (name) {
        if (!eventPresence.has(room)) eventPresence.set(room, new Map());
        eventPresence.get(room).set(socket.id, { name });
        socket.data.eventRooms = socket.data.eventRooms || new Set();
        socket.data.eventRooms.add(room);
      }
      emitPresence(eventId); // broadcast the updated list (also seeds a just-joined host)
    });
    socket.on(ClientEvents.LeaveEvent, (arg) => {
      const eventId = arg && typeof arg === 'object' ? arg.eventId : arg;
      if (eventId == null) return;
      const room = eventRoom(eventId);
      socket.leave(room);
      const m = eventPresence.get(room);
      if (m && m.delete(socket.id)) { socket.data.eventRooms?.delete(room); emitPresence(eventId); }
    });
    socket.on('disconnect', () => {
      for (const room of socket.data.eventRooms || []) {
        const m = eventPresence.get(room);
        if (m && m.delete(socket.id)) {
          io.to(room).emit(ServerEvents.PresenceChanged, {
            eventId: room.slice(room.indexOf(':') + 1), connected: presenceNames(room),
          });
        }
      }
    });

    // Live stopwatch relay — stamp StartedUtc server-side so every viewer ticks
    // from the same reference (rundan's StartTimer/StopTimer hub methods).
    socket.on(ClientEvents.StartTimer, (arg) => {
      const activityId = arg?.activityId;
      if (activityId == null) return;
      emit.timerStarted(activityId, {
        activityId: String(activityId),
        key: arg.key,
        startedUtc: new Date().toISOString(),
      });
    });
    socket.on(ClientEvents.StopTimer, (arg) => {
      const activityId = arg?.activityId;
      if (activityId == null) return;
      emit.timerStopped(activityId, { activityId: String(activityId), key: arg.key });
    });
  });

  emit.setIO(io);
  return io;
}

module.exports = { initSockets };
