import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDefaultLevel, parseQualityPreference } from '../lib/playback-quality.ts';

const levels = [
  { index: 0, height: 1080, bitrate: 4_000_000 },
  { index: 1, height: 360, bitrate: 500_000 },
  { index: 2, height: 720, bitrate: 2_000_000 },
  { index: 3, height: 480, bitrate: 900_000 },
];

test('stored room quality accepts only supported preferences', () => {
  assert.equal(parseQualityPreference('best'), 'best');
  assert.equal(parseQualityPreference('720'), '720');
  assert.equal(parseQualityPreference(undefined), 'auto');
  assert.equal(parseQualityPreference('720p'), 'auto');
  assert.equal(parseQualityPreference({ value: '720' }), 'auto');
});

test('the room default selects actual levels from an unsorted manifest', () => {
  assert.equal(chooseDefaultLevel({ preference: 'auto', levels }), -1);
  assert.equal(chooseDefaultLevel({ preference: 'best', levels }), 0);
  assert.equal(chooseDefaultLevel({ preference: '720', levels }), 2);
  assert.equal(chooseDefaultLevel({ preference: '480', levels }), 3);
  assert.equal(chooseDefaultLevel({ preference: '1440', levels }), 0);
  assert.equal(chooseDefaultLevel({ preference: '2160', levels }), 0);
});

test('missing requested resolution falls back below, then to the lowest above', () => {
  assert.equal(chooseDefaultLevel({ preference: '720', levels: [levels[0], levels[1], levels[3]] }), 3);
  assert.equal(chooseDefaultLevel({ preference: '360', levels: [levels[0], levels[2], levels[3]] }), 3);
});

test('highest available uses bitrate when every rendition has unknown height', () => {
  const unknown = [{ index: 0, height: 0, bitrate: 10_000_000 }, { index: 1, height: NaN, bitrate: 20_000_000 }];
  assert.equal(chooseDefaultLevel({ preference: 'best', levels: [] }), -1);
  assert.equal(chooseDefaultLevel({ preference: 'best', levels: unknown }), 1);
  assert.equal(chooseDefaultLevel({ preference: '720', levels: [unknown[0], levels[3]] }), 3);
  assert.equal(chooseDefaultLevel({ preference: '720', levels: unknown }), -1);
  assert.equal(chooseDefaultLevel({ preference: 'best', levels: [{ index: 0, height: 0, bitrate: 0 }, { index: 1, height: NaN, bitrate: NaN }] }), -1);
});

test('same-height variants prefer valid higher bitrate, then original index', () => {
  const tied = [
    { index: 4, height: 720, bitrate: 2_000_000 },
    { index: 2, height: 720, bitrate: 2_000_000 },
    { index: 1, height: 720, bitrate: NaN },
    { index: 0, height: 1080, bitrate: 1_000_000 },
  ];
  assert.equal(chooseDefaultLevel({ preference: '720', levels: tied }), 2);
  assert.equal(chooseDefaultLevel({ preference: 'best', levels: tied }), 0);
});
