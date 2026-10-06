import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { recognizedDlivePixelTransport } = require('../desktop/sportsurge-observer.cjs');
const source = 'https://public-cdn.example/channel123/index.m3u8';
const valid = {
  playerUrl: 'https://dlive.sx/stream/stream-111.php',
  frameUrl: 'https://dembed.top/embed/channel123',
  jwSource: source,
  observedUrl: `${source}?_=1234567890123`,
  loaderConfigured: true,
};

test('declared Dlive player with its custom JW loader can identify its own observed HLS', () => {
  assert.equal(recognizedDlivePixelTransport(valid), true);
  assert.equal(recognizedDlivePixelTransport({ ...valid, observedUrl: source }), true);
});

test('a different frame, HLS source, loader, or forged hint cannot claim pixel transport', () => {
  const invalid = [
    { ...valid, playerUrl: 'https://other.example/stream/stream-111.php' },
    { ...valid, playerUrl: 'https://dlive.sx/stream/stream-0.php' },
    { ...valid, frameUrl: 'https://ad.example/embed/channel123' },
    { ...valid, jwSource: 'http://public-cdn.example/channel123/index.m3u8' },
    { ...valid, observedUrl: 'https://public-cdn.example/other/index.m3u8?_=1234567890123' },
    { ...valid, observedUrl: `${source}?_=1234567890123&other=1` },
    { ...valid, loaderConfigured: false },
    { ...valid, playerUrl: 'https://ad.example/stream/stream-111.php', transport: 'dlive-pixel-gzip-ts' },
  ];
  for (const [index, evidence] of invalid.entries()) {
    assert.equal(recognizedDlivePixelTransport(evidence), false, String(index));
  }
});
