// Socket emit helpers — the port of rundan's ScoreboardNotifier. Services/routes
// call these after a write to push the matching realtime event to the right
// room. Holds the live io instance (set during initSockets).
const { ServerEvents, activityRoom, eventRoom } = require('../constants/socketEvents');

let io = null;
const setIO = (instance) => { io = instance; };
const getIO = () => io;

const emitToActivity = (activityId, event, payload) => {
  if (io && activityId != null) io.to(activityRoom(activityId)).emit(event, payload);
};
const emitToEvent = (eventId, event, payload) => {
  if (io && eventId != null) io.to(eventRoom(eventId)).emit(event, payload);
};

module.exports = {
  setIO,
  getIO,
  emitToActivity,
  emitToEvent,
  scoreboardUpdated: (activityId, dto) => emitToActivity(activityId, ServerEvents.ScoreboardUpdated, dto),
  participantJoined: (activityId, dto) => emitToActivity(activityId, ServerEvents.ParticipantJoined, dto),
  activityStatusChanged: (activityId, dto) =>
    emitToActivity(activityId, ServerEvents.ActivityStatusChanged, dto),
  viewersChanged: (eventId, dto) => emitToEvent(eventId, ServerEvents.ViewersChanged, dto),
  // EventChanged payload is a BARE id (string), not an object — do not wrap.
  eventChanged: (eventId) => emitToEvent(eventId, ServerEvents.EventChanged, String(eventId)),
  chatPosted: (eventId, dto) => emitToEvent(eventId, ServerEvents.ChatPosted, dto),
  timerStarted: (activityId, dto) => emitToActivity(activityId, ServerEvents.TimerStarted, dto),
  timerStopped: (activityId, dto) => emitToActivity(activityId, ServerEvents.TimerStopped, dto),
  musicTrackStarted: (activityId, dto) =>
    emitToActivity(activityId, ServerEvents.MusicTrackStarted, dto),
  hitsterStateChanged: (activityId, dto) =>
    emitToActivity(activityId, ServerEvents.HitsterStateChanged, dto),
};
