const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { ClientEvents, activityRoom, eventRoom } = require('../constants/socketEvents');
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

  io.on('connection', (socket) => {
    socket.on(ClientEvents.JoinActivity, (activityId) => {
      if (activityId != null) socket.join(activityRoom(activityId));
    });
    socket.on(ClientEvents.LeaveActivity, (activityId) => {
      if (activityId != null) socket.leave(activityRoom(activityId));
    });
    socket.on(ClientEvents.JoinEvent, (eventId) => {
      if (eventId != null) socket.join(eventRoom(eventId));
    });
    socket.on(ClientEvents.LeaveEvent, (eventId) => {
      if (eventId != null) socket.leave(eventRoom(eventId));
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
