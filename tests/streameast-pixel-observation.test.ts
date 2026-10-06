import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import { observedPublicPage, observedStreameastServerPage } from '../lib/playback/providers/public-page.ts';

const ts = Buffer.alloc(188 * 4, 0xff);
for (let offset = 0; offset < ts.length; offset += 188) ts[offset] = 0x47;
function pngChunk(name: string, data: Buffer): Buffer {
  const kind = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, check]);
}
function encodedSegment(): Buffer {
  const gzip = gzipSync(ts);
  const payload = Buffer.alloc(12 + gzip.length);
  payload.write('TIKTIKPX');
  payload.writeUInt32BE(gzip.length, 8);
  gzip.copy(payload, 12);
  const width = 16;
  const height = Math.ceil(payload.length / (width * 3));
  const pixels = Buffer.alloc(width * height * 3);
  payload.copy(pixels);
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

const eventUrl = new URL('https://v2.streameast.ga/nfl/atlanta-falcons-vs-new-orleans-saints-1/');
const serverUrl = new URL('4', eventUrl);
const playlistUrl = 'https://public-cdn.example/channel123/index.m3u8';
const mediaUrl = 'https://public-cdn.example/channel123/segment.ts';
const capability = '11111111-1111-4111-8111-111111111111';

async function observed<T>(transport: string | undefined, run: () => Promise<T>): Promise<{value:T; revocations:number}> {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const originalToken = process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  let revocations = 0;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN = 'http://127.0.0.1:45678';
  process.env.SUNDAY_ROOM_CONTROL_TOKEN = 'fixture-control';
  globalThis.fetch = async (input,init) => {
    const address = String(input);
    if (address.endsWith('/observe')) return Response.json({
      url: playlistUrl, referer: 'https://dembed.top/embed/channel123', userAgent: 'Mozilla/5.0', capability,
      ...(transport === undefined ? {} : { transport }),
    });
    if (address.endsWith(`/media/${capability}`) && init?.method === 'DELETE') {
      revocations++;
      return new Response(null, { status: 204 });
    }
    if (address.endsWith('/media')) {
      const body = JSON.parse(String(init?.body));
      if (body.url === playlistUrl) return new Response('#EXTM3U\n#EXTINF:5\nsegment.ts\n', {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
      if (body.url === mediaUrl) return new Response(encodedSegment(), { headers: { 'content-type': 'image/png' } });
    }
    throw new Error('Unexpected observer fixture request');
  };
  try { return { value: await run(), revocations }; }
  finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
    else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN = originalOrigin;
    if (originalToken === undefined) delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
    else process.env.SUNDAY_ROOM_CONTROL_TOKEN = originalToken;
  }
}

test('trusted StreamEast observation decodes a selected PNG fragment and retains revocation', async () => {
  const result = await observed('dlive-pixel-gzip-ts', async () => {
    const playback = await observedStreameastServerPage({serverUrl,eventUrl,sourceEventId:'nfl:46236',serverId:'4'},
      new AbortController().signal, 'probe');
    assert.ok(playback);
    const media = playback.root.resolve('segment.ts', 'media');
    assert.ok(media);
    const response = await media.read({signal:new AbortController().signal});
    assert.equal(response.contentType, 'video/mp2t');
    assert.deepEqual(Buffer.from(await new Response(response.body).arrayBuffer()), ts);
    playback.close();
    await assert.rejects(media.read({signal:new AbortController().signal}), /closed/);
    await new Promise(resolve => setImmediate(resolve));
    return true;
  });
  assert.equal(result.value, true);
  assert.equal(result.revocations, 1);
});

test('ordinary observations and unknown transport tags cannot enable PNG decoding', async () => {
  for (const transport of ['dlive-pixel-gzip-ts', 'unknown-transport']) {
    await observed(transport, async () => {
      await assert.rejects(observedPublicPage(serverUrl,new AbortController().signal,'probe'), /transport/);
      return true;
    });
  }
  await observed('unknown-transport', async () => {
    await assert.rejects(observedStreameastServerPage({serverUrl,eventUrl,sourceEventId:'nfl:46236',serverId:'4'},
      new AbortController().signal, 'probe'), /transport/);
    return true;
  });
  await observed(undefined, async () => {
    const playback = await observedPublicPage(serverUrl,new AbortController().signal,'probe');
    assert.ok(playback);
    const media = playback.root.resolve('segment.ts','media');
    assert.ok(media);
    assert.equal((await media.read({signal:new AbortController().signal})).contentType, 'image/png');
    playback.close();
    return true;
  });
});
