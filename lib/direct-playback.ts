export type PlaybackFailure = 'gesture' | 'error' | null;

// Pausing or replacing a source intentionally cancels a pending play request.
export function playbackFailure(error: unknown): PlaybackFailure {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'AbortError') return null;
  return name === 'NotAllowedError' ? 'gesture' : 'error';
}

// Repeated waiting/stalled events describe the same interruption. They must not
// keep extending the deadline forever when playback makes no progress.
export function createPlaybackWatchdog(onTimeout: () => void, delay = 20000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    start() {
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; onTimeout(); }, delay);
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

type MediaSnapshot = { readyState: number; paused: boolean; ended: boolean; error: unknown };
type MediaSignal = 'playing' | 'loadeddata' | 'loadedmetadata' | 'pause' | 'ended' | 'error';

// Media events are queued tasks. A source replacement or a quick pause/resume
// can change the element again before an earlier event reaches its listener.
export function currentMediaSignal(signal: MediaSignal, media: MediaSnapshot): boolean {
  if (signal === 'error') return !!media.error;
  if (media.error) return false;
  if (signal === 'pause') return media.paused && !media.ended;
  if (signal === 'ended') return media.ended;
  if (signal === 'loadedmetadata') return media.readyState >= 1;
  if (signal === 'playing') return media.readyState >= 2 && !media.paused && !media.ended;
  return media.readyState >= 2;
}

export function liveSeekTarget(
  ranges: Pick<TimeRanges, 'length' | 'start' | 'end'>,
  live: boolean,
  delay: number,
): number | null {
  if (!live || !ranges.length) return null;
  const index = ranges.length - 1;
  const start = ranges.start(index), end = ranges.end(index);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const seconds = Number.isFinite(delay) ? Math.max(3, delay) : 3;
  return Math.max(start, end - seconds);
}

// A requested delay can arrive while a live window is temporarily unavailable.
// Keep the latest request pending until the media actually accepts the seek.
export function createLiveSeekRequest(target: () => number | null, seek: (time: number) => void) {
  let pending = true;
  const apply = () => {
    if (!pending) return;
    try {
      const time = target();
      if (time === null) return;
      seek(time);
      pending = false;
    } catch { /* Retry when the next media event exposes a usable live window. */ }
  };
  return { apply, request: () => { pending = true; apply(); } };
}

// Fatal errors have already exhausted hls.js's ordinary request retries. Keep
// recovery bounded so an unavailable feed eventually offers a useful retry.
export function createRecoveryBudget() {
  let network = 0, media = 0;
  return (type: string, details?: string): { action: 'manifest' | 'network' | 'media'; delay: number } | null => {
    if (type === 'networkError' && network < 2) {
      // startLoad resumes segments only; it cannot retry an absent manifest.
      const manifest = details === 'manifestLoadError' || details === 'manifestLoadTimeOut' || details === 'manifestParsingError';
      return { action: manifest ? 'manifest' : 'network', delay: ++network * 1000 };
    }
    if (type === 'mediaError' && media < 1) { media++; return { action: 'media', delay: 0 }; }
    return null;
  };
}
