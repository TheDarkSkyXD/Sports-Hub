import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeVideoEvidence, type EvidenceClock, type EvidenceVideo } from '../lib/playback/video-evidence.ts';
import type { AdvancingVideo } from '../lib/playback/advancing-video.ts';

function fixture(frameCallbacks = true, sampleIntervalMs: 0 | 1000 = 1000) {
  let now = 0;
  let nextId = 0;
  let frames = 1;
  let frozen = false;
  let callbacks = 0;
  let qualityReads = 0;
  let eligible = true;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const requests = new Map<number, (now: number, metadata: { mediaTime: number; presentedFrames: number }) => void>();
  const events = new Map<string, Set<() => void>>();
  const proofs: { at: number; evidence: AdvancingVideo }[] = [];
  const clock: EvidenceClock = {
    now: () => now,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => { timers.delete(id); },
  };
  const video: EvidenceVideo = {
    currentTime: 0, videoWidth: 1920, videoHeight: 1080, paused: false, seeking: false, readyState: 4,
    addEventListener(type, listener) { const listeners = events.get(type) ?? new Set(); listeners.add(listener); events.set(type, listeners); },
    removeEventListener(type, listener) { events.get(type)?.delete(listener); },
    getVideoPlaybackQuality() { qualityReads++; return { totalVideoFrames: frames, droppedVideoFrames: 0 }; },
    ...(frameCallbacks ? {
      requestVideoFrameCallback(callback) { const id = ++nextId; requests.set(id, callback); return id; },
      cancelVideoFrameCallback(id) { requests.delete(id); },
    } satisfies Pick<EvidenceVideo, 'requestVideoFrameCallback' | 'cancelVideoFrameCallback'> : {}),
  };
  const present = () => {
    for (const [id, callback] of [...requests]) {
      requests.delete(id); callbacks++; callback(now, { mediaTime: video.currentTime, presentedFrames: frames });
    }
  };
  const advance = (ms: number) => {
    const target = now + ms;
    while (now < target) {
      const step = Math.min(20, target - now);
      now += step;
      if (!frozen && !video.paused && !video.seeking) { video.currentTime = (Math.round(video.currentTime * 1000) + step) / 1000; frames++; }
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      if (!frozen && !video.paused && !video.seeking) present();
    }
  };
  const observer = observeVideoEvidence({ video, clock, sourceStartedAt: 0, sampleIntervalMs,
    canSample: () => eligible,
    onProof: evidence => { proofs.push({ at: now, evidence }); },
  });
  present();
  return { video, observer, proofs, advance, present,
    emit: (type: string) => { for (const listener of [...(events.get(type) ?? [])]) listener(); },
    freeze: (value: boolean) => { frozen = value; },
    eligibility: (value: boolean) => { eligible = value; },
    sleep: (ms: number) => { now += ms; video.currentTime += ms / 1000; frames += ms / 20; },
    counts: () => ({ callbacks, qualityReads, timers: timers.size, requests: requests.size,
      listeners: [...events.values()].reduce((count, listeners) => count + listeners.size, 0) }),
  };
}

test('presented-frame evidence keeps the two-second proof and sixty-second renewal with bounded callbacks', () => {
  const room = fixture();
  room.advance(1980);
  assert.equal(room.proofs.length, 0);
  room.advance(20);
  assert.equal(room.proofs.length, 1);
  assert.equal(room.proofs[0].at, 2000);
  assert.equal(room.proofs[0].evidence.observedMs, 2000);
  assert.equal(room.proofs[0].evidence.startupMs, 2000);
  room.advance(59_980);
  assert.equal(room.proofs.length, 1);
  room.advance(20);
  assert.equal(room.proofs.length, 2);
  assert.equal(room.proofs[1].at, 62_000);
  assert.equal(room.proofs[1].evidence.observedMs, 2000);
  assert.equal(room.proofs[1].evidence.startupMs, 2000);
  assert.ok(room.counts().callbacks <= 7, `too many evidence callbacks: ${room.counts().callbacks}`);
  room.observer.stop();
});

test('verification checks every presented frame until its two-second proof', () => {
  const room = fixture(true, 0);
  room.advance(1980);
  assert.equal(room.proofs.length, 0);
  assert.equal(room.counts().callbacks, 100);
  room.advance(20);
  assert.equal(room.proofs.length, 1);
  assert.equal(room.proofs[0].at, 2000);
  assert.equal(room.counts().callbacks, 101);
  room.observer.stop();
});

test('verification fallback keeps timeupdate cadence without a zero-delay polling loop', () => {
  const room = fixture(false, 0);
  room.advance(1000);
  assert.equal(room.counts().timers, 0);
  assert.equal(room.counts().qualityReads, 1);
  room.emit('timeupdate');
  room.advance(1000); room.emit('timeupdate');
  assert.equal(room.proofs.length, 1);
  room.observer.stop();
  assert.equal(room.counts().listeners, 0);
});

test('a suspended clock cannot count a gap longer than six seconds toward the first proof', () => {
  const room = fixture();
  room.advance(1000); room.sleep(7000); room.advance(20);
  assert.equal(room.proofs.length, 0);
  room.advance(1980);
  assert.equal(room.proofs.length, 0);
  room.advance(20);
  assert.equal(room.proofs.length, 1);
  assert.equal(room.proofs[0].evidence.observedMs, 2000);
  assert.equal(room.proofs[0].evidence.startupMs, 10_020);
  room.observer.stop();
});

test('pause, waiting and seeking require a fresh advancing window', () => {
  for (const interruption of ['pause', 'waiting', 'seeking']) {
    const room = fixture();
    room.advance(1000);
    if (interruption === 'pause') room.video.paused = true;
    if (interruption === 'seeking') room.video.seeking = true;
    room.emit(interruption);
    room.freeze(true);
    room.advance(3000);
    assert.equal(room.proofs.length, 0, interruption);
    room.video.paused = false; room.video.seeking = false; room.freeze(false);
    room.emit(interruption === 'seeking' ? 'seeked' : 'playing'); room.present();
    room.advance(1980);
    assert.equal(room.proofs.length, 0, interruption);
    room.advance(20);
    assert.equal(room.proofs.length, 1, interruption);
    assert.equal(room.proofs[0].at, 6000, interruption);
    room.observer.stop();
  }
});

test('frozen frames, seeks, lost eligibility and a sleep longer than six seconds cannot renew stale evidence', () => {
  const room = fixture();
  room.advance(2000);
  room.freeze(true);
  room.advance(70_000);
  assert.equal(room.proofs.length, 1);
  room.freeze(false); room.present(); room.advance(1980);
  assert.equal(room.proofs.length, 1);
  room.advance(20);
  assert.equal(room.proofs.length, 2);
  room.emit('seeking'); room.emit('seeked'); room.present(); room.advance(1000);
  room.sleep(7000); room.advance(20);
  room.advance(1980);
  assert.equal(room.proofs.length, 2);
  room.eligibility(false); room.advance(4000);
  room.eligibility(true); room.video.currentTime += 30;
  room.advance(2000);
  assert.equal(room.proofs.length, 2);
  room.observer.stop();
});

test('playback-quality fallback proves advancing video without subscribing to every timeupdate', () => {
  const room = fixture(false);
  room.advance(2000);
  assert.equal(room.proofs.length, 1);
  room.advance(60_000);
  assert.equal(room.proofs.length, 2);
  assert.ok(room.counts().qualityReads <= 7);
  room.observer.stop();
});

test('stop cancels pending timers, frame callbacks and event listeners across source replacement', () => {
  const room = fixture();
  room.advance(1000);
  room.observer.stop(); room.observer.stop(); room.emit('playing');
  assert.deepEqual(room.counts(), { callbacks: 2, qualityReads: 0, timers: 0, requests: 0, listeners: 0 });
  room.advance(65_000); room.emit('playing'); room.present();
  assert.equal(room.proofs.length, 0);
  const next = fixture(); next.advance(2000);
  assert.equal(next.proofs.length, 1);
  next.observer.stop();
});
