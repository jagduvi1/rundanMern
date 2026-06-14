// Vibration helper — the React port of rundan's VibrationInterop + wwwroot/js/vibrate.js.
// The Vibration API is a no-op where unsupported (notably iOS Safari), so every
// call is feature-guarded and errors are swallowed (vibration is a nice-to-have).
//
// `pattern` may be a single duration in ms (e.g. 200) or an array describing an
// on/off pattern (e.g. [80, 40, 120]). Call directly from event handlers
// (correct-answer feedback, slap, etc.) — no hook needed.
export function vibrate(pattern = 200) {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    /* ignore — vibration is a nice-to-have */
  }
}

export function canVibrate() {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}
