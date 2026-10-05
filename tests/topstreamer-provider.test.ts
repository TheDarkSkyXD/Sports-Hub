import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { probeCandidate } from '../lib/playback/probe.ts';
import { publishedTopstreamerVideo } from '../lib/playback/providers/topstreamer.ts';
import type { Requester } from '../lib/playback/providers/public-page.ts';
import { registeredResource, revokeSession, rewritePlaylist } from '../lib/stream-relay.ts';

const parent = new URL('https://methstreams.st/event/m-atlanta-falcons-vs-new-orleans-saints-1006');
const server = new URL('https://fxtrend.st/event/m-atlanta-falcons-vs-new-orleans-saints-1006');
const mainRoute = new URL(`${server.href}/main/1`);
const middle = new URL('https://trendy48.site/top/saints');
const player = new URL('https://topstreamer.site/iframe/nfl/saints');
const snapshot = readFileSync(new URL('./fixtures/topstreamer-saints-snapshot.html', import.meta.url), 'utf8');
const eventPage = `<link rel="canonical" href="${server.href}"><div class="player-embed-wrap"><iframe id="streamIframe" src="${middle.href}"></iframe></div>`;
const middlePage = `<script>var f=document.createElement('iframe');f.src = "${player.href}";document.body.appendChild(f);</script><noscript><iframe src="${player.href}"></iframe></noscript>`;
const signal = () => new AbortController().signal;

function fixtureRequester(input?: {snapshot?: string; segment?: string; gzip?: boolean; rotate?: boolean;
  server?: URL; canonical?: string}) {
  const requests: {host: string; referer: string | null}[] = [];
  let snapshots = 0;
  const requester: Requester = async (url, active, headers) => {
    active.throwIfAborted();
    requests.push({host:url.hostname,referer:headers.get('referer')});
    if (url.href === (input?.server ?? server).href) return new Response(
      eventPage.replace(`href="${server.href}"`,`href="${input?.canonical ?? server.href}"`),
      {headers:{'content-type':'text/html'}});
    if (url.href === middle.href) return new Response(middlePage,{headers:{'content-type':'text/html'}});
    if (url.href === player.href) {
      const number=snapshots++;
      const body = (input?.snapshot ?? snapshot).replace('MEDIA-SEQUENCE:100',`MEDIA-SEQUENCE:${100 + number}`)
        .replace('segment_a.ts',input?.rotate && number > 1 ? 'segment_d.ts' : 'segment_a.ts');
      return new Response(input?.gzip ? gzipSync(body) : body,{headers:{'content-type':'text/html',
        ...(input?.gzip ? {'content-encoding':'gzip'} : {})}});
    }
    if (url.hostname === 'media.example') {
      const media = Buffer.alloc(188 * 4);
      for (let offset=0;offset<media.length;offset+=188) media[offset]=0x47;
      return new Response(input?.segment ?? media,{headers:{'content-type':'video/MP2T'}});
    }
    throw new Error(`Unexpected fixture request to ${url.hostname}`);
  };
  return {requester,requests};
}

async function text(body: ReadableStream<Uint8Array> | null) {
  assert.ok(body);
  return new Response(body).text();
}

test('published Main 1 creates a playable HLS resource and refreshes the live rendition', async () => {
  const {requester,requests}=fixtureRequester();
  const playback=await publishedTopstreamerVideo(server,parent,signal(),requester);
  assert.ok(playback);
  try {
    const master=await text((await playback.root.read({signal:signal()})).body);
    assert.match(master,/^#EXTM3U/);
    const variantName=master.split('\n').find(line=>line==='3_saints.m3u8');
    assert.ok(variantName);
    const variant=playback.root.resolve(variantName,'playlist');
    assert.ok(variant);
    const first=await text((await variant.read({signal:signal()})).body);
    const firstIdentity=variant.identity;
    const second=await text((await variant.read({signal:signal()})).body);
    assert.match(first,/#EXT-X-MEDIA-SEQUENCE:101/);
    assert.match(second,/#EXT-X-MEDIA-SEQUENCE:102/);
    assert.notEqual(variant.identity,firstIdentity);
    const segment=variant.resolve(first.split('\n').find(line=>line.includes('/segment_a.ts?')) ?? '', 'media');
    assert.ok(segment);
    const read=await segment.read({signal:signal()});
    assert.equal(read.status,200);
    assert.equal((await new Response(read.body).arrayBuffer()).byteLength,188*4);
    assert.deepEqual(requests.slice(0,3),[
      {host:'fxtrend.st',referer:parent.href},
      {host:'trendy48.site',referer:server.href},
      {host:'topstreamer.site',referer:middle.href},
    ]);
    assert.equal(requests.at(-1)?.referer,player.href);
  } finally { playback.close(); }
});

test('published Main 1 route accepts only its own event-base canonical', async () => {
  const {requester,requests}=fixtureRequester({server:mainRoute});
  const playback=await publishedTopstreamerVideo(mainRoute,parent,signal(),requester);
  assert.ok(playback);
  try {
    assert.equal(requests[0]?.referer,parent.href);
    assert.equal(requests[1]?.referer,mainRoute.href);
  } finally { playback.close(); }
  const unrelated=fixtureRequester({server:mainRoute,
    canonical:'https://fxtrend.st/event/m-other-game-vs-another-team-1006'});
  assert.equal(await publishedTopstreamerVideo(mainRoute,parent,signal(),unrelated.requester),null);
});

test('Main 1 passes the actual candidate media probe', async () => {
  const {requester}=fixtureRequester({gzip:true});
  const locator={provider:'event-page' as const,gameId:'401872979',eventUrl:parent.href,serverUrl:server.href};
  const result=await probeCandidate(locator,signal(),async (_locator,active) => {
    const playback=await publishedTopstreamerVideo(server,parent,active,requester);
    assert.ok(playback);
    return playback;
  });
  assert.deepEqual(result,{kind:'playable',proof:'media'});
});

test('Main 1 rejects foreign variants and private media targets', async () => {
  const normal=fixtureRequester();
  const playback=await publishedTopstreamerVideo(server,parent,signal(),normal.requester);
  assert.ok(playback);
  try {
    assert.equal(playback.root.resolve('other-game.m3u8','playlist'),null);
    assert.equal(playback.root.resolve('https://other.example/other.m3u8','playlist'),null);
  } finally { playback.close(); }
  const privateSnapshot=snapshot.replace('https://media.example/live/ephemeral/event/528k/segment_a.ts',
    'http://127.0.0.1/internal');
  const unsafe=fixtureRequester({snapshot:privateSnapshot});
  const rejected=await publishedTopstreamerVideo(server,parent,signal(),unsafe.requester);
  assert.equal(rejected,null);
  const privateKey=snapshot.replace('#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1/key"\\n#EXT-X-INDEPENDENT-SEGMENTS');
  assert.equal(await publishedTopstreamerVideo(server,parent,signal(),fixtureRequester({snapshot:privateKey}).requester),null);
});

test('overlapping playlist refreshes retain both published segment references', async () => {
  const {requester}=fixtureRequester({rotate:true});
  const playback=await publishedTopstreamerVideo(server,parent,signal(),requester);
  assert.ok(playback);
  try {
    const variant=playback.root.resolve('3_saints.m3u8','playlist');
    assert.ok(variant);
    const [first,second]=await Promise.all([
      variant.read({signal:signal()}).then(read=>text(read.body)),
      variant.read({signal:signal()}).then(read=>text(read.body)),
    ]);
    const earlier=[first,second].find(body=>body.includes('/segment_a.ts?'));
    const later=[first,second].find(body=>body.includes('/segment_d.ts?'));
    assert.ok(earlier);
    assert.ok(later);
    const firstRef=earlier.split('\n').find(line=>line.includes('/segment_a.ts?'));
    const secondRef=later.split('\n').find(line=>line.includes('/segment_d.ts?'));
    assert.ok(firstRef);
    assert.ok(secondRef);
    assert.ok(variant.resolve(firstRef,'media'));
    assert.ok(variant.resolve(secondRef,'media'));
    const grant={sessionId:'topstreamer-overlap',candidateId:'main-1',generation:1,gameId:'401872979'};
    try {
      const firstBody=rewritePlaylist(earlier,variant,grant);
      const secondBody=rewritePlaylist(later,variant,grant);
      const firstToken=/\/api\/stream\/media\/([a-f0-9]{48})/.exec(firstBody)?.[1];
      const secondToken=/\/api\/stream\/media\/([a-f0-9]{48})/.exec(secondBody)?.[1];
      assert.ok(firstToken);
      assert.ok(secondToken);
      assert.notEqual(firstToken,secondToken);
      assert.notEqual(registeredResource(firstToken)?.resource.identity,
        registeredResource(secondToken)?.resource.identity);
    } finally { revokeSession(grant.sessionId); }
  } finally { playback.close(); }
});

test('Main 1 resources stop after close and honor cancellation', async () => {
  const {requester}=fixtureRequester();
  const playback=await publishedTopstreamerVideo(server,parent,signal(),requester);
  assert.ok(playback);
  playback.close();
  await assert.rejects(playback.root.read({signal:signal()}),/closed/i);
  const aborted=new AbortController();
  aborted.abort();
  await assert.rejects(publishedTopstreamerVideo(server,parent,aborted.signal,requester));
});
