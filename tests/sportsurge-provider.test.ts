import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isPublicAddress, publicHttpsRequest, sportsurgeUrl, sportsurgeV2Provider } from '../lib/playback/providers/sportsurge-v2.ts';
import { registeredResource, revokeSession, rewritePlaylist } from '../lib/stream-relay.ts';

const locator = { provider: 'sportsurge-v2' as const, eventId: 'ncaaf:123', providerId: 'stream-123-0',
  url: 'https://provider.example/watch/123' };

test('Sportsurge URLs reject unsafe authorities and DNS results', async () => {
  assert.equal(sportsurgeUrl(locator.url)?.href, locator.url);
  assert.equal(sportsurgeUrl('https://media.example:8443/live.m3u8')?.port, '8443');
  for (const value of [
    'http://provider.example/watch', 'https://user@provider.example/watch',
    'https://provider.example:8080/watch', 'https://provider.example./watch',
    'https://127.0.0.1/playlist.m3u8', 'https://[::1]/playlist.m3u8',
    'https://localhost/watch', 'https://provider.local/watch',
    'https://provider.example/watch#fragment', 'https://provider.example\\@127.0.0.1/watch',
  ]) assert.equal(sportsurgeUrl(value), null, value);
  for (const value of ['10.0.0.1', '172.16.2.3', '192.168.1.1', '100.64.1.2', '169.254.0.1',
    '127.0.0.1', '0.1.2.3', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:c0a8:101::'])
    assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(publicHttpsRequest(new URL(locator.url), new AbortController().signal, new Headers(),
    async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), /private address/);
});

test('Sportsurge resolves a page manifest into scoped HLS resources', async () => {
  const manifest = 'https://cdn.example/live/index.m3u8?st=abc';
  const segment = 'https://media.example/live/segment.ts?st=def';
  const requests: Array<{ url: string; referer: string | null; range: string | null }> = [];
  const requester = async (url: URL, _signal: AbortSignal, headers: Headers): Promise<Response> => {
    requests.push({ url: url.href, referer: headers.get('referer'), range: headers.get('range') });
    if (url.href === locator.url) return new Response(`<video><source src="${manifest}"></video>`,
      { headers: { 'Content-Type': 'text/html' } });
    if (url.href === manifest) return new Response(`#EXTM3U\n#EXTINF:5,\n${segment}\n`,
      { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    if (url.href === segment) return new Response(new Uint8Array([0x47, 0, 0]),
      { status: 206, headers: { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-2/3' } });
    throw new Error(`Unexpected ${url.href}`);
  };
  const playback = await sportsurgeV2Provider(requester).open(locator, new AbortController().signal);
  const playlist = await playback.root.read({ signal: new AbortController().signal });
  assert.equal(await new Response(playlist.body).text(), `#EXTM3U\n#EXTINF:5,\n${segment}\n`);
  const grant = { sessionId: '9b916b55-189a-4bcf-81da-c1b7e28ef800', gameId: 'ncaaf-123', candidateId: 'sportsurge-123', generation: 0 };
  try {
    const rewritten = rewritePlaylist(`#EXTM3U\n#EXTINF:5,\n${segment}\n`, playback.root, grant);
    const token = /\/api\/stream\/media\/([a-f0-9]{48})/.exec(rewritten)?.[1];
    assert.ok(token);
    const child = registeredResource(token)?.resource;
    assert.ok(child);
    const read = await child.read({ signal: new AbortController().signal, range: 'bytes=0-2' });
    assert.equal(read.status, 206);
    assert.equal(await new Response(read.body).arrayBuffer().then(value => value.byteLength), 3);
    assert.deepEqual(requests.map(item => item.url), [locator.url, manifest, segment]);
    assert.equal(requests[1].referer, locator.url);
    assert.equal(requests[2].range, 'bytes=0-2');
    assert.equal(playback.root.resolve('http://media.example/private.ts', 'media'), null);
    assert.equal(playback.root.resolve('https://127.0.0.1/private.ts', 'media'), null);
  } finally { revokeSession(grant.sessionId); playback.close(); }
});

test('Sportsurge bounds redirects and page extraction', async () => {
  const visited: string[] = [];
  const requester = async (url: URL): Promise<Response> => {
    visited.push(url.href);
    if (url.href === locator.url) return new Response(null, { status: 302, headers: { Location: '/player' } });
    if (url.href === 'https://provider.example/player') return new Response('<iframe src="https://embed.example/player"></iframe>',
      { headers: { 'Content-Type': 'text/html' } });
    if (url.href === 'https://embed.example/player') return new Response('file: "https://cdn.example/live.m3u8"',
      { headers: { 'Content-Type': 'text/html' } });
    throw new Error(`Unexpected ${url.href}`);
  };
  const playback = await sportsurgeV2Provider(requester).open(locator, new AbortController().signal);
  assert.equal(playback.root.identity, 'https://cdn.example/live.m3u8');
  assert.deepEqual(visited, [locator.url, 'https://provider.example/player', 'https://embed.example/player']);
  await assert.rejects(sportsurgeV2Provider(async () => new Response(null,
    { status: 302, headers: { Location: 'http://127.0.0.1/admin' } })).open(locator, new AbortController().signal), /unsafe/);
  await assert.rejects(sportsurgeV2Provider(async () => new Response('x'.repeat(1024 * 1024 + 1),
    { headers: { 'Content-Type': 'text/html' } })).open(locator, new AbortController().signal), /too large/);
});

test('Sportsurge uses the private browser observer when static HTML has no HLS', async () => {
  const requests: Array<{ path: string | undefined; token: string | undefined; body: string }> = [];
  const server = createServer((request, response) => {
    const parts: Uint8Array[] = [];
    request.on('data', part => parts.push(part));
    request.on('end', () => {
      requests.push({ path: request.url, token: request.headers['x-sunday-control-token']?.toString(),
        body: Buffer.concat(parts).toString('utf8') });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ url: 'https://cdn.example/live/index.m3u8', referer: 'https://provider.example/embed',userAgent:'Observed Chromium/1.0' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const previousOrigin = process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const previousToken = process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN = `http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN = 'test-control-token';
  try {
    const headers:Headers[]=[];
    const playback = await sportsurgeV2Provider(async (url,_signal,requestHeaders) => {
      if(url.hostname==='cdn.example') {
        headers.push(requestHeaders);
        return new Response(url.pathname.endsWith('.m3u8')?'#EXTM3U\n#EXTINF:4,\nsegment.ts':'segment',
          {headers:{'Content-Type':url.pathname.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'}});
      }
      return new Response('<div>No stream in static HTML</div>',{headers:{'Content-Type':'text/html'}});
    }).open(locator, new AbortController().signal);
    assert.equal(playback.root.identity, 'https://cdn.example/live/index.m3u8');
    const rootRead=await playback.root.read({signal:AbortSignal.timeout(1000)});
    await rootRead.body?.cancel();
    const segment=playback.root.resolve('segment.ts','media');
    assert.ok(segment);
    const segmentRead=await segment.read({signal:AbortSignal.timeout(1000)});
    await segmentRead.body?.cancel();
    assert.equal(headers.length,2);
    assert.ok(headers.every(value=>value.get('user-agent')==='Observed Chromium/1.0'&&value.get('referer')==='https://provider.example/embed'));
    assert.deepEqual(requests, [{ path: '/observe', token: 'test-control-token', body: JSON.stringify({ url: locator.url, purpose:'playback' }) }]);
  } finally {
    if (previousOrigin === undefined) delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
    else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN = previousOrigin;
    if (previousToken === undefined) delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
    else process.env.SUNDAY_ROOM_CONTROL_TOKEN = previousToken;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
