const START_TIMEOUT = 25000;
const STALL_TIMEOUT = 25000;
const BUFFERING_DELAY = 4000;
const STABLE_PLAYBACK_TIME = 15000;

function createPlaybackHealth(now = Date.now()) {
  return { lastProgress: now, lastTime: null, started: false, stableSince: null };
}

// A readyState alone cannot detect a frozen picture. Keep watching the media
// clock after startup, while giving paused and hidden players a fresh grace period.
function samplePlaybackHealth(health, media, { now = Date.now(), playing = true, visible = true } = {}) {
  if (!playing || !visible) {
    health.lastProgress = now;
    health.lastTime = Number.isFinite(media?.time) ? media.time : null;
    health.stableSince = null;
    return 'idle';
  }
  const usable = media && !media.error && !media.ended && media.ready >= 3 && !media.paused && Number.isFinite(media.time) && media.time > 0;
  if (usable && media.time !== health.lastTime) {
    health.lastProgress = now;
    health.lastTime = media.time;
    health.started = true;
    health.stableSince ??= now;
    return 'playing';
  }
  const elapsed = now - health.lastProgress;
  if (media?.error || media?.ended || elapsed >= BUFFERING_DELAY) health.stableSince = null;
  if (media?.error || media?.ended || elapsed >= (health.started ? STALL_TIMEOUT : START_TIMEOUT)) return 'retry';
  if (health.started && elapsed >= BUFFERING_DELAY) return 'buffering';
  return health.started ? 'playing' : 'starting';
}

// A server that supplies a single frame and freezes must not replenish the
// fallback budget. Only sustained playback starts a fresh recovery incident.
function playbackIsStable(health, now = Date.now()) {
  return health.stableSince !== null && now - health.stableSince >= STABLE_PLAYBACK_TIME;
}

module.exports = { createPlaybackHealth, samplePlaybackHealth, playbackIsStable };
