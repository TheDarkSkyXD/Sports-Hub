import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import type { ProviderReadResult, ProviderResource } from '../lib/playback/provider.ts';
import { wrapDlivePixelResource } from '../lib/playback/providers/streameast-pixel.ts';

const packetCount = 5;
const ts = Buffer.alloc(packetCount * 188, 0xff);
for (let packet = 0; packet < packetCount; packet++) ts[packet * 188] = 0x47;

function chunk(kind: string, data: Buffer): Buffer {
  const type = Buffer.from(kind, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, check]);
}

function pixelPng(payload = ts, marker = 'TIKTIKPX', dimensions?: { width: number; height: number }): Buffer {
  const gzip = gzipSync(payload);
  const header = Buffer.alloc(12);
  header.write(marker, 0, 'ascii');
  header.writeUInt32BE(gzip.length, 8);
  const encoded = Buffer.concat([header, gzip]);
  const width = dimensions?.width ?? 16;
  const height = dimensions?.height ?? Math.ceil(encoded.length / (width * 3));
  const rgb = Buffer.alloc(width * height * 3);
  encoded.copy(rgb);
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fixture(data: Buffer, contentType = 'image/png') {
  let reads = 0;
  let ranges = 0;
  const media: ProviderResource = {
    kind: 'media', identity: 'https://public.example/segment.ts',
    async read(input): Promise<ProviderReadResult> {
      reads++;
      if (input.range) ranges++;
      return { status: 200, contentType, contentLength: String(data.length),
        body: new Response(data).body };
    },
    resolve() { return null; },
  };
  const root: ProviderResource = {
    kind: 'playlist', identity: 'https://public.example/index.m3u8',
    async read() { return { status: 200, contentType: 'application/vnd.apple.mpegurl',
      body: new Response('#EXTM3U\n#EXTINF:5\nsegment.ts\n').body }; },
    resolve(reference, expected) { return reference === 'segment.ts' && expected === 'media' ? media : null; },
  };
  return { root, media, metrics: () => ({ reads, ranges }) };
}

async function bytes(result: ProviderReadResult): Promise<Buffer> {
  assert.ok(result.body);
  const chunks: Buffer[] = [];
  for await (const value of result.body) chunks.push(Buffer.from(value));
  return Buffer.concat(chunks);
}

test('declared Dlive pixel media becomes complete TS before a playback reader receives bytes', async () => {
  const input = fixture(pixelPng());
  const root = wrapDlivePixelResource(input.root);
  const media = root.resolve('segment.ts', 'media');
  assert.ok(media);
  const result = await media.read({ signal: new AbortController().signal });
  assert.equal(result.status, 200);
  assert.equal(result.contentType, 'video/mp2t');
  assert.equal(result.contentLength, String(ts.length));
  assert.equal(result.contentRange, undefined);
  assert.equal(result.acceptRanges, undefined);
  assert.deepEqual(await bytes(result), ts);
  assert.equal(input.metrics().reads, 1);
});

test('pixel media rejects an invalid marker and excessive dimensions before exposing a stream', async () => {
  const badCrc = Buffer.from(pixelPng());
  badCrc[29] ^= 1;
  const inflatedTooLarge = Buffer.from(pixelPng());
  inflatedTooLarge.writeUInt32BE(4096, 16);
  inflatedTooLarge.writeUInt32BE(3000, 20);
  inflatedTooLarge.writeUInt32BE(crc32(inflatedTooLarge.subarray(12, 29)), 29);
  for (const png of [pixelPng(ts, 'BADBADPX'), pixelPng(ts, 'TIKTIKPX', { width: 50000, height: 1 }),
    badCrc, inflatedTooLarge]) {
    const input = fixture(png);
    const media = wrapDlivePixelResource(input.root).resolve('segment.ts', 'media');
    assert.ok(media);
    await assert.rejects(media.read({ signal: new AbortController().signal }));
  }
});

test('pixel media rejects unsupported ranges without issuing an upstream range read', async () => {
  const input = fixture(pixelPng());
  const media = wrapDlivePixelResource(input.root).resolve('segment.ts', 'media');
  assert.ok(media);
  const result = await media.read({ signal: new AbortController().signal, range: 'bytes=0-187' });
  assert.equal(result.status, 416);
  assert.equal(result.body, null);
  assert.equal(input.metrics().ranges, 0);
});

test('plain TS and unrelated resources retain their original bytes', async () => {
  const ordinary = fixture(ts, 'video/mp2t');
  const wrapped = wrapDlivePixelResource(ordinary.root).resolve('segment.ts', 'media');
  assert.ok(wrapped);
  assert.deepEqual(await bytes(await wrapped.read({ signal: new AbortController().signal })), ts);
  const unwrapped = fixture(pixelPng()).media;
  assert.deepEqual((await bytes(await unwrapped.read({ signal: new AbortController().signal }))).subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('aborted pixel reads cannot publish decoded bytes', async () => {
  const input = fixture(pixelPng());
  const media = wrapDlivePixelResource(input.root).resolve('segment.ts', 'media');
  assert.ok(media);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(media.read({ signal: controller.signal }));
});
