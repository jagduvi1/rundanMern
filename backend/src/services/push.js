// Web Push notifications — the MERN port of rundan's `PushService.cs`.
//
// Sends browser Web Push notifications to everyone subscribed to an event. VAPID
// keys are configured ONCE globally in server.js (`web-push`.setVapidDetails) when
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are present — so this module just requires
// `web-push` and calls sendNotification. With no keys configured push is a no-op.
//
// All sends are best-effort and fire-and-forget — a failed notification must NEVER
// fail a request. Subscriptions that the push service reports as 404/410 (Gone /
// Not Found) are pruned.

const env = require('../config/env');
const { PushSubscription } = require('../models');
const { idStr } = require('./serializers');

// Last seen overall-standings leader per event (identity string), so we fire the
// "new leader" push only when the lead actually changes hands. Process-local
// state (mirrors the C# singleton field): losing it on restart just means the
// next finish won't fire a leader push until the lead changes again.
const lastLeader = new Map();

/**
 * The VAPID public key the browser needs for PushManager.subscribe, or '' when
 * push isn't configured. Port of PushService.PublicKey.
 *
 * @returns {string}
 */
function vapidPublicKey() {
  return env.vapidPublicKey || '';
}

// Push is enabled only when both VAPID keys are configured (PushService.Enabled).
function enabled() {
  return env.hasWebPush;
}

// Lazily grab the globally-configured web-push client (configured in server.js).
function webpush() {
  // eslint-disable-next-line global-require
  return require('web-push');
}

/**
 * Send a Web Push notification to EVERY subscription for an event, pruning any
 * that the push service reports as expired (404/410). No-op when push isn't
 * configured. The whole thing is wrapped so a failure never bubbles to the
 * caller. Port of PushService.SendToEventAsync.
 *
 * @param {string} eventId
 * @param {{title?:string, body?:string, url?:string, tag?:string}} payload
 * @returns {Promise<void>}
 */
async function sendToEvent(eventId, payload) {
  if (!enabled()) return;

  try {
    const subs = await PushSubscription.find({ eventId })
      .select('_id endpoint p256dh auth')
      .lean();
    if (subs.length === 0) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url,
      tag: payload.tag ?? null,
    });

    const wp = webpush();
    const stale = [];
    await Promise.all(subs.map(async (s) => {
      try {
        await wp.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
      } catch (ex) {
        const code = ex && ex.statusCode;
        if (code === 410 || code === 404) {
          stale.push(s._id); // subscription expired — drop it
        }
        // other errors: swallow (debug-level in the C#) and continue
      }
    }));

    if (stale.length > 0) {
      await PushSubscription.deleteMany({ _id: { $in: stale } });
    }
  } catch {
    // a failed notify must not bubble up (logged-and-ignored in the C#)
  }
}

/**
 * Fire-and-forget convenience over sendToEvent — kicks off the send without
 * awaiting so request handlers stay fast. Port of PushService.Notify.
 *
 * @param {string} eventId
 * @param {string} title
 * @param {string} body
 * @param {string} url   relative deep-link the service worker opens (e.g. "e/{id}")
 * @param {string} [tag] collapses duplicate notifications
 */
function notify(eventId, title, body, url, tag = null) {
  // Deliberately not awaited; never let a rejection become an unhandled one.
  sendToEvent(eventId, { title, body, url, tag }).catch(() => {});
}

/**
 * Notify when an activity finishes: who won, a slap (if slaps are on), and a new
 * overall-standings leader if the lead changed hands. Best-effort; no-op when
 * push isn't configured. Port of PushService.NotifyActivityFinishedAsync.
 *
 * Lazily requires the models + scoreboard/standings services so this module stays
 * cheap to load and avoids any require cycle.
 *
 * @param {string} activityId
 * @returns {Promise<void>}
 */
async function notifyActivityFinished(activityId) {
  if (!enabled()) return;

  try {
    // eslint-disable-next-line global-require
    const { Activity, Event } = require('../models');
    // eslint-disable-next-line global-require
    const { buildScoreboard } = require('./scoreboard');
    // eslint-disable-next-line global-require
    const { buildStandings } = require('./standings');

    const activity = await Activity.findById(activityId).select('_id eventId title').lean();
    if (!activity || !activity.eventId) return;
    const eventId = idStr(activity.eventId);

    const ev = await Event.findById(eventId).select('_id name slapMode').lean();
    if (!ev) return;

    // Winners = scoreboard rows ranked 1st.
    const board = await buildScoreboard(activityId);
    const winners = board ? board.entries.filter((e) => e.rank === 1).map((e) => e.displayName) : [];
    if (winners.length > 0) {
      const who = winners.join(' & ');
      notify(eventId, '🏆 We have a winner!', `${who} won “${activity.title}”.`, `e/${eventId}`, `won-${idStr(activity)}`);
      if (ev.slapMode !== 0 /* SlapMode.Off */) {
        notify(eventId, '👋 Slap time!', `${who} can slap a rival after “${activity.title}”.`, `e/${eventId}`, `slap-${idStr(activity)}`);
      }
    }

    // New overall leader (only when the lead changed hands).
    const standings = await buildStandings(eventId);
    const leader = standings ? standings.entries.find((e) => e.rank === 1) : null;
    if (leader) {
      // Identity: "u{userId}" for roster users, else "n{displayName}" for free-name.
      const id = leader.userId ? `u${leader.userId}` : `n${leader.displayName}`;
      const prev = lastLeader.get(eventId);
      if (prev !== undefined && prev !== id) {
        notify(eventId, '🥇 New leader!', `${leader.displayName} is now top of ${ev.name}.`, `e/${eventId}`, `leader-${eventId}`);
      }
      lastLeader.set(eventId, id);
    }
  } catch {
    // notify-finished failure must not bubble (logged-and-ignored in the C#)
  }
}

module.exports = {
  vapidPublicKey,
  enabled,
  sendToEvent,
  notify,
  notifyActivityFinished,
  // Exposed for tests — resets the process-local leader memory.
  _clearLeaders: () => lastLeader.clear(),
};
