import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { sportsurgeUrl } from '../lib/playback/providers/public-page.ts';

const require = createRequire(import.meta.url);
const { createObservedMedia } = require('../desktop/observed-media.cjs');

class ChromiumRequest extends EventEmitter {
  target: string;
  constructor(target: string) { super(); this.target = target; }
  headers: Record<string, string> = {};
  aborted = false;
  setHeader(name: string, value: string) { this.headers[name] = value; }
  abort() { if (!this.aborted) { this.aborted = true; this.emit('abort'); } }
  end() {
    setImmediate(() => {
      if (this.aborted) return;
      if (this.target.endsWith('/hang')) return;
      if (this.target.endsWith('/redirect')) {
        this.emit('redirect', 302, 'GET', 'https://segments.example/segment.ts');
        return;
      }
      const incoming = Object.assign(new PassThrough(), {
        statusCode: this.headers.Range ? 206 : 200,
        headers: { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-3/4' },
      });
      this.emit('response', incoming);
      incoming.end(Buffer.from([0x47, 1, 2, 3]));
    });
  }
}

test('observed media preserves captured headers, ranges, cross-origin children, and capability lifetime', async () => {
  const requests: ChromiumRequest[] = [];
  let connectionsClosed = 0;
  let sessionsCreated = 0;
  let authCachesCleared = 0;
  const transport = createObservedMedia({
    pinAddress: async () => ({ address: '93.184.216.34', family: 4 }),
    validateUrl: sportsurgeUrl,
    idleMs: 1000,
    network: { request({ url }: { url: string }) { const request = new ChromiumRequest(url); requests.push(request); return request; } },
    sessions: { fromPartition: () => { sessionsCreated++; return {
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
      webRequest: { onBeforeRequest() {} },
      async setProxy() {}, async closeAllConnections() { connectionsClosed++; },
      async clearAuthCache() { authCachesCleared++; },
    }; } },
  });
  const root = { url: 'https://media.example/root.m3u8', userAgent: 'Observed Chromium', origin: 'https://embed.example',
    mediaCookie: 'session=published-player' };
  let capability = await transport.register(root);
  const server = createServer((request, response) => {
    transport.read(capability, new URL(request.url || '/', 'http://local').searchParams.get('url'), request.headers.range, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const read = (url: string, range?: string, signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}/?${new URLSearchParams({ url })}`, {
    headers: range ? { Range: range } : {}, redirect: 'manual', signal,
  });
  try {
    const response = await read('https://segments.example/segment.ts', 'bytes=0-3');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-3/4');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x47, 1, 2, 3]);
    assert.deepEqual(requests[0].headers, { 'User-Agent': 'Observed Chromium', Accept: '*/*', Origin: 'https://embed.example', Range: 'bytes=0-3' });
    const sameOrigin = await read('https://media.example/segment.ts');
    assert.equal(sameOrigin.status, 200);
    await sameOrigin.arrayBuffer();
    assert.equal(requests.at(-1)?.headers.Cookie, 'session=published-player');
    for (const url of ['http://media.example/segment.ts', 'https://127.0.0.1/segment.ts', 'https://user@media.example/segment.ts']) {
      assert.equal((await read(url)).status, 404);
    }
    for (const range of ['bytes=4-3', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4']) {
      assert.equal((await read('https://media.example/segment.ts', range)).status, 404);
    }
    for (const range of ['bytes=0-', 'bytes=-4']) {
      const ranged = await read('https://media.example/segment.ts', range);
      assert.equal(ranged.status, 206);
      await ranged.arrayBuffer();
      assert.equal(requests.at(-1)?.headers.Range, range);
    }
    const redirect = await read('https://media.example/redirect');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), 'https://segments.example/segment.ts');
    assert.equal(await redirect.text(), '');
    await assert.rejects(read('https://media.example/hang', undefined, AbortSignal.timeout(50)), /abort|timeout/i);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests.at(-1)?.aborted, true);
    transport.close(capability);
    assert.equal((await read('https://media.example/segment.ts')).status, 404);
    capability = await transport.register({ ...root, requestReferer: 'https://embed.example/player' });
    const second = await read('https://media.example/segment.ts');
    assert.equal(second.status, 200);
    await second.arrayBuffer();
    assert.equal(requests.at(-1)?.headers.Referer, 'https://embed.example/player');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal((await read('https://media.example/segment.ts')).status, 404);
    assert.equal(connectionsClosed, 2);
    for (let index = 0; index < 40; index++) {
      capability = await transport.register(root);
      transport.close(capability);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(sessionsCreated, 1);
    assert.equal(authCachesCleared, 42);
  } finally {
    transport.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('transient native cleanup failures do not exhaust media partitions or reuse a dirty session', async () => {
  let created = 0;
  const media = createObservedMedia({
    pinAddress: async () => ({ address: '93.184.216.34', family: 4 }),
    validateUrl: sportsurgeUrl,
    sessions: { fromPartition: () => {
      created++;
      let used = false;
      let clean = true;
      let closeAttempts = 0;
      return {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest() {} },
        async setProxy() {
          assert.equal(clean, true, 'a session with open native connections cannot be reused');
          used = true;
          clean = false;
        },
        async closeAllConnections() {
          if (++closeAttempts === 1) throw new Error('transient native cleanup failure');
        },
        async clearAuthCache() {
          assert.equal(used, true);
          clean = true;
        },
      };
    } },
  });
  try {
    for (let index = 0; index < 32; index++) {
      const capability = await media.register({ url: 'https://media.example/root.m3u8', userAgent: 'Observed Chromium' });
      assert.ok(capability);
      media.close(capability);
      await new Promise(resolve => setImmediate(resolve));
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    const recovered = await media.register({ url: 'https://media.example/root.m3u8', userAgent: 'Observed Chromium' });
    assert.ok(recovered, 'a transient cleanup error must not permanently consume the 32-session pool');
    assert.ok(created <= 32);
    media.close(recovered);
  } finally {
    media.stop();
  }
});

test('permanent native cleanup failures keep the media partition count bounded', async () => {
  let created = 0;
  const media = createObservedMedia({
    pinAddress: async () => ({ address: '93.184.216.34', family: 4 }),
    validateUrl: sportsurgeUrl,
    sessions: { fromPartition: () => {
      created++;
      return {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest() {} },
        async setProxy() {},
        async closeAllConnections() { throw new Error('permanent native cleanup failure'); },
        async clearAuthCache() {},
      };
    } },
  });
  try {
    for (let index = 0; index < 32; index++) {
      const capability = await media.register({ url: 'https://media.example/root.m3u8', userAgent: 'Observed Chromium' });
      assert.ok(capability);
      media.close(capability);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(await media.register({ url: 'https://media.example/root.m3u8', userAgent: 'Observed Chromium' }), null);
    assert.equal(created, 32);
  } finally {
    media.stop();
  }
});

test('a timed out native cleanup stays quarantined after its late completion', async () => {
  let created = 0;
  let clearAuthCalls = 0;
  let releaseCleanup: (() => void) | undefined;
  const stalledCleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const media = createObservedMedia({
    pinAddress: async () => ({ address: '93.184.216.34', family: 4 }),
    validateUrl: sportsurgeUrl,
    sessions: { fromPartition: () => {
      const first = ++created === 1;
      return {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest() {} },
        async setProxy() {},
        closeAllConnections: () => first ? stalledCleanup : Promise.resolve(),
        async clearAuthCache() { if (first) clearAuthCalls++; },
      };
    } },
  });
  try {
    const first = await media.register({ url: 'https://media.example/root.m3u8', userAgent: 'Observed Chromium' });
    assert.ok(first);
    media.close(first);
    for (let index = 0; index < 31; index++) {
      const occupied = await media.register({ url: 'https://media.example/root.m3u8', userAgent: 'Observed Chromium' });
      assert.ok(occupied);
    }
    await new Promise(resolve => setTimeout(resolve, 5100));
    assert.equal(await media.register({ url: 'https://media.example/root.m3u8', userAgent: 'Observed Chromium' }), null);
    releaseCleanup?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clearAuthCalls, 0);
    assert.equal(await media.register({ url: 'https://media.example/root.m3u8', userAgent: 'Observed Chromium' }), null);
    assert.equal(created, 32);
  } finally {
    media.stop();
    releaseCleanup?.();
  }
});
