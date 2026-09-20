import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSeekRequest, createPlaybackWatchdog, createRecoveryBudget, currentMediaSignal, liveSeekTarget, playbackFailure } from '../lib/direct-playback.ts';

const ranges = (...windows: [number, number][]) => ({
  length: windows.length,
  start: (index: number) => windows[index][0],
  end: (index: number) => windows[index][1],
});

test('intentional play cancellation is ignored and only browser permission errors request a gesture', () => {
  assert.equal(playbackFailure(new DOMException('Paused', 'AbortError')), null);
  assert.equal(playbackFailure(new DOMException('Autoplay blocked', 'NotAllowedError')), 'gesture');
  assert.equal(playbackFailure(new DOMException('Unsupported codec', 'NotSupportedError')), 'error');
  assert.equal(playbackFailure(new Error('Playback failed')), 'error');
});

test('live delay targets the latest seekable window without seeking into a gap', () => {
  const windows = ranges([0, 20], [80, 120]);
  assert.equal(liveSeekTarget(windows, true, 10), 110);
  assert.equal(liveSeekTarget(windows, true, 45), 80);
  assert.equal(liveSeekTarget(windows, true, 0), 117);
});

test('live delay leaves finite replays and unavailable seek windows untouched', () => {
  assert.equal(liveSeekTarget(ranges([0, 100]), false, 15), null);
  assert.equal(liveSeekTarget(ranges(), true, 15), null);
  assert.equal(liveSeekTarget(ranges([100, 100]), true, 15), null);
  assert.equal(liveSeekTarget(ranges([0, Infinity]), true, 15), null);
  assert.equal(liveSeekTarget(ranges([50, 100]), true, NaN), 97);
});

test('a changed live delay waits for the returning seekable window and applies only once', () => {
  let window = ranges([100, 160]), delay = 5;
  const seeks: number[] = [];
  const pending = createLiveSeekRequest(() => liveSeekTarget(window, true, delay), time => seeks.push(time));
  pending.apply();
  assert.deepEqual(seeks, [155]);

  window = ranges();
  delay = 25;
  pending.request();
  pending.apply();
  assert.deepEqual(seeks, [155], 'Changing delay during recovery cannot seek yet');
  window = ranges([130, 190]);
  pending.apply();
  assert.deepEqual(seeks, [155, 165], 'The new delay must apply when the buffer returns');
  window = ranges([140, 200]);
  pending.apply();
  assert.deepEqual(seeks, [155, 165], 'Playlist refreshes must not repeatedly jump playback');
});

test('failed live seeks stay pending and newer delay requests replace older ones', () => {
  let delay = 10, canSeek = false;
  const seeks: number[] = [];
  const pending = createLiveSeekRequest(() => liveSeekTarget(ranges([100, 160]), true, delay), time => {
    if (!canSeek) throw new DOMException('Live window moved', 'InvalidStateError');
    seeks.push(time);
  });
  pending.apply();
  delay = 20;
  pending.request();
  delay = 40;
  pending.request();
  canSeek = true;
  pending.apply();
  assert.deepEqual(seeks, [120]);
  pending.apply();
  assert.deepEqual(seeks, [120]);
});

test('fatal HLS network and decoder recovery are bounded independently for each source', () => {
  const recover = createRecoveryBudget();
  assert.deepEqual(recover('networkError'), { action: 'network', delay: 1000 });
  assert.deepEqual(recover('networkError'), { action: 'network', delay: 2000 });
  assert.equal(recover('networkError'), null);
  assert.deepEqual(recover('mediaError'), { action: 'media', delay: 0 });
  assert.equal(recover('mediaError'), null);
  assert.equal(recover('keySystemError'), null);
  assert.deepEqual(createRecoveryBudget()('networkError'), { action: 'network', delay: 1000 });
});

test('initial manifest failures retry the manifest and share the bounded network recovery budget', () => {
  const recover = createRecoveryBudget();
  assert.deepEqual(recover('networkError', 'manifestLoadError'), { action: 'manifest', delay: 1000 });
  assert.deepEqual(recover('networkError', 'manifestLoadTimeOut'), { action: 'manifest', delay: 2000 });
  assert.equal(recover('networkError', 'fragLoadError'), null);
  assert.deepEqual(createRecoveryBudget()('networkError', 'manifestParsingError'), { action: 'manifest', delay: 1000 });
  assert.deepEqual(createRecoveryBudget()('networkError', 'fragLoadError'), { action: 'network', delay: 1000 });
});

test('queued pause and ended events cannot overwrite a resumed stream', () => {
  const resumed = { readyState: 4, paused: false, ended: false, error: null };
  assert.equal(currentMediaSignal('pause', resumed), false);
  assert.equal(currentMediaSignal('ended', resumed), false);
  assert.equal(currentMediaSignal('playing', resumed), true);
  assert.equal(currentMediaSignal('pause', { ...resumed, paused: true }), true);
  assert.equal(currentMediaSignal('ended', { ...resumed, paused: true, ended: true }), true);
  assert.equal(currentMediaSignal('playing', { ...resumed, paused: true }), false);
});

test('source replacement ignores old load, playing, and error events until the new media is ready', () => {
  const replaced = { readyState: 0, paused: true, ended: false, error: null };
  for (const signal of ['loadedmetadata', 'loadeddata', 'playing', 'ended', 'error'] as const) {
    assert.equal(currentMediaSignal(signal, replaced), false, signal);
  }
  assert.equal(currentMediaSignal('loadedmetadata', { ...replaced, readyState: 1 }), true);
  assert.equal(currentMediaSignal('loadeddata', { ...replaced, readyState: 2 }), true);
  assert.equal(currentMediaSignal('error', { ...replaced, error: { code: 4 } }), true);
  assert.equal(currentMediaSignal('playing', { ...replaced, readyState: 4, paused: false, error: { code: 3 } }), false);
});

test('repeated stall events cannot postpone the playback failure deadline indefinitely', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let failures = 0;
  const watchdog = createPlaybackWatchdog(() => { failures++; });
  watchdog.start();
  for (let count = 0; count < 3; count++) {
    context.mock.timers.tick(5000);
    watchdog.start();
  }
  assert.equal(failures, 0);
  context.mock.timers.tick(5000);
  assert.equal(failures, 1);
});

test('recovered or disposed playback cancels its deadline and the next stall gets a full interval', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let failures = 0;
  const watchdog = createPlaybackWatchdog(() => { failures++; });
  watchdog.start();
  context.mock.timers.tick(15000);
  watchdog.stop();
  context.mock.timers.tick(30000);
  assert.equal(failures, 0);
  watchdog.start();
  context.mock.timers.tick(19999);
  assert.equal(failures, 0);
  context.mock.timers.tick(1);
  assert.equal(failures, 1);
  watchdog.start();
  watchdog.stop();
  context.mock.timers.tick(20000);
  assert.equal(failures, 1);
});
