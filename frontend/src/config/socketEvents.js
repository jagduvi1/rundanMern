// ES-module mirror of backend/src/constants/socketEvents.js. Keep in sync.

export const ServerEvents = Object.freeze({
  ScoreboardUpdated: 'ScoreboardUpdated',
  ParticipantJoined: 'ParticipantJoined',
  ActivityStatusChanged: 'ActivityStatusChanged',
  ViewersChanged: 'ViewersChanged',
  EventChanged: 'EventChanged', // payload is a BARE id string
  ChatPosted: 'ChatPosted',
  TimerStarted: 'TimerStarted',
  TimerStopped: 'TimerStopped',
  MusicTrackStarted: 'MusicTrackStarted',
  HitsterStateChanged: 'HitsterStateChanged',
  PresenceChanged: 'PresenceChanged', // { eventId, connected: [name] }
});

export const ClientEvents = Object.freeze({
  JoinActivity: 'JoinActivity',
  LeaveActivity: 'LeaveActivity',
  JoinEvent: 'JoinEvent',
  LeaveEvent: 'LeaveEvent',
  StartTimer: 'StartTimer',
  StopTimer: 'StopTimer',
});
