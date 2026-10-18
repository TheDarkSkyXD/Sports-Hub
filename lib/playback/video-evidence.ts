import { createAdvancingVideoSampler, type AdvancingVideo } from './advancing-video.ts';

export type EvidenceVideo = Pick<HTMLVideoElement, 'currentTime' | 'videoWidth' | 'videoHeight' | 'paused' | 'seeking' | 'readyState'> & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: Pick<VideoFrameCallbackMetadata, 'mediaTime' | 'presentedFrames'>) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
  getVideoPlaybackQuality?: () => Pick<VideoPlaybackQuality, 'totalVideoFrames' | 'droppedVideoFrames'>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

export type EvidenceClock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (id: number) => void;
};

export function observeVideoEvidence({ video, canSample, sourceStartedAt, onProof, sampleIntervalMs = 1000, clock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: id => window.clearTimeout(id),
} }: {
  video: EvidenceVideo;
  canSample: () => boolean;
  sourceStartedAt: number;
  onProof: (proof: AdvancingVideo) => void;
  sampleIntervalMs?: 0 | 1000;
  clock?: EvidenceClock;
}) {
  const sampler = createAdvancingVideoSampler(sourceStartedAt);
  let active = true;
  let suspended = false;
  let nextEvidenceAt = 0;
  let timer: number | undefined;
  let frame: number | undefined;
  const cancel = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    if (frame !== undefined) video.cancelVideoFrameCallback?.(frame);
    timer = undefined;
    frame = undefined;
  };
  const schedule = (delay: number) => {
    if (!active || suspended) return;
    if (delay === 0) {
      if (video.requestVideoFrameCallback) observe();
    } else timer = clock.setTimeout(observe, delay);
  };
  const sample = (mediaMs: number, frames: number) => {
    if (!active || suspended) return;
    const now = clock.now();
    if (!canSample() || video.paused || video.seeking || video.readyState < 2) {
      sampler.reset();
      schedule(1000);
      return;
    }
    const proof = sampler.sample({ wallMs: now, mediaMs, currentMs: video.currentTime * 1000,
      frames, width: video.videoWidth, height: video.videoHeight, playing: true });
    if (proof && now >= nextEvidenceAt) {
      nextEvidenceAt = now + 60_000;
      onProof(proof);
    }
    schedule(sampleIntervalMs === 0 ? 0 : proof ? Math.max(1000, nextEvidenceAt - now - 2000) : sampleIntervalMs);
  };
  function observe() {
    timer = undefined;
    if (!active || suspended) return;
    if (!canSample() || video.paused || video.seeking || video.readyState < 2) {
      sampler.reset();
      if (sampleIntervalMs !== 0 || video.requestVideoFrameCallback) schedule(1000);
    } else if (video.requestVideoFrameCallback) {
      frame = video.requestVideoFrameCallback((_now, metadata) => {
        frame = undefined;
        sample(metadata.mediaTime * 1000, metadata.presentedFrames);
      });
    } else if (video.getVideoPlaybackQuality) {
      const quality = video.getVideoPlaybackQuality();
      sample(video.currentTime * 1000, quality.totalVideoFrames - quality.droppedVideoFrames);
    }
  }
  const reset = () => {
    cancel();
    sampler.reset();
    if (active && !suspended) observe();
  };
  const suspend = () => { suspended = true; reset(); };
  const resume = () => { suspended = false; reset(); };
  for (const event of ['pause', 'waiting', 'seeking']) video.addEventListener(event, suspend);
  for (const event of ['playing', 'seeked']) video.addEventListener(event, resume);
  const usesProgressEvents = sampleIntervalMs === 0 && !video.requestVideoFrameCallback;
  if (usesProgressEvents) video.addEventListener('timeupdate', observe);
  observe();
  return {
    stop() {
      active = false;
      cancel();
      sampler.reset();
      for (const event of ['pause', 'waiting', 'seeking']) video.removeEventListener(event, suspend);
      for (const event of ['playing', 'seeked']) video.removeEventListener(event, resume);
      if (usesProgressEvents) video.removeEventListener('timeupdate', observe);
    },
  };
}
