// Lazy socket.io singleton — the port of rundan's ScoreboardConnection. The
// client lib (~40 KB gz) is dynamically imported so only pages that need
// realtime pull it in. The handshake carries the host JWT (if logged in) and the
// access code (if the deployment is gated); players connect anonymously.
import { getHostToken, getAccessCode } from '../api/client';
import { ClientEvents } from '../config/socketEvents';

let socket = null;
let socketPromise = null;

export async function getSocket() {
  if (socket && socket.connected) return socket;
  if (!socketPromise) {
    socketPromise = (async () => {
      const { io } = await import('socket.io-client');
      socket = io({
        path: '/api/socket.io',
        auth: { token: getHostToken() || undefined, accessCode: getAccessCode() || undefined },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
      });
      return socket;
    })();
  }
  return socketPromise;
}

export function closeSocket() {
  if (socket) socket.disconnect();
  socket = null;
  socketPromise = null;
}

// Room helpers (rooms map 1:1 with rundan's SignalR groups).
export async function joinActivity(activityId) {
  (await getSocket()).emit(ClientEvents.JoinActivity, activityId);
}
export async function leaveActivity(activityId) {
  (await getSocket()).emit(ClientEvents.LeaveActivity, activityId);
}
export async function joinEvent(eventId) {
  (await getSocket()).emit(ClientEvents.JoinEvent, eventId);
}
export async function leaveEvent(eventId) {
  (await getSocket()).emit(ClientEvents.LeaveEvent, eventId);
}
export async function startTimer(activityId, key) {
  (await getSocket()).emit(ClientEvents.StartTimer, { activityId, key });
}
export async function stopTimer(activityId, key) {
  (await getSocket()).emit(ClientEvents.StopTimer, { activityId, key });
}
