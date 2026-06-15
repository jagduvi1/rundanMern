// Socket.IO event names — the port of rundan's strongly-typed SignalR contract
// (`IScoreboardClient` + the hub's client→server methods). In .NET the event
// name strings equalled the method names so server and client could not drift;
// we keep one shared module here for the same reason.
//
// Duplicated (identical) in frontend/src/config/socketEvents.js as an ES module.

// Server → client (server emits, clients subscribe).
const ServerEvents = Object.freeze({
  ScoreboardUpdated: 'ScoreboardUpdated',
  ParticipantJoined: 'ParticipantJoined',
  ActivityStatusChanged: 'ActivityStatusChanged',
  ViewersChanged: 'ViewersChanged',
  EventChanged: 'EventChanged', // payload is a BARE integer/string eventId
  ChatPosted: 'ChatPosted',
  TimerStarted: 'TimerStarted',
  TimerStopped: 'TimerStopped',
  MusicTrackStarted: 'MusicTrackStarted',
  HitsterStateChanged: 'HitsterStateChanged',
});

// Client → server (clients emit, server handles).
const ClientEvents = Object.freeze({
  JoinActivity: 'JoinActivity',
  LeaveActivity: 'LeaveActivity',
  JoinEvent: 'JoinEvent',
  LeaveEvent: 'LeaveEvent',
  StartTimer: 'StartTimer',
  StopTimer: 'StopTimer',
});

// Room naming — 1:1 with rundan's SignalR groups (`activity-{id}`, `event-{id}`).
// We use a colon separator (socket.io idiom); the id is the Mongo _id string.
const activityRoom = (activityId) => `activity:${activityId}`;
const eventRoom = (eventId) => `event:${eventId}`;

module.exports = { ServerEvents, ClientEvents, activityRoom, eventRoom };
