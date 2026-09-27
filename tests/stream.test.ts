import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandidateSchema, PlaybackSchema, candidateSummary } from '../lib/football/shared.ts';
import { goozResource, goozSourceFromEmbed, validGoozResourceUrl } from '../lib/playback/providers/gooz.ts';
import { streamcenterProvider, streamcenterResource, validStreamcenterResourceUrl } from '../lib/playback/providers/streamcenter.ts';
import type { ProviderResource } from '../lib/playback/provider.ts';
import { expireIdleStreams, openGeneration, registeredResource, registerResource, resourceCount, revokeGeneration, revokeSession,
  rewritePlaylist, streamSignal, touchStreamSession, validByteRange } from '../lib/stream-relay.ts';

const grant=(sessionId:string,generation=0)=>({sessionId,candidateId:'gooz-57069',generation,gameId:'ncaaf-401858468'});
const root='https://chatgpt.hereisman.net/playlist/57069/load-playlist';
const variant='https://pl.playlist3.space/playlist/57069/proton1/caxi';
const media=`https://proton1.2f4049362e3069c1dbb69a47b280e76a.r2.cloudflarestorage.com/scripts/NTcwNjk%3D/segment.txt?X-Amz-Signature=${'a'.repeat(64)}`;

test('Gooz provider accepts only its player-bound HLS grammar',()=>{
  assert.equal(goozSourceFromEmbed(`<script>const source = "${root}";</script>`,'57069'),root);
  assert.equal(goozSourceFromEmbed(`atobClappr("${Buffer.from(root).toString('base64')}")`,'57069'),root);
  assert.equal(goozSourceFromEmbed(`<script>const source = "${root}";</script>`,'57068'),null);
  assert.equal(validGoozResourceUrl(root,'57069','playlist'),true);
  assert.equal(validGoozResourceUrl(variant,'57069','playlist'),true);
  assert.equal(validGoozResourceUrl(media,'57069','media'),true);
  assert.equal(validGoozResourceUrl('https://pl.playlist5.space/playlist/57083/mountainstormbreeze25/caxi','57083','playlist'),true);
  assert.equal(validGoozResourceUrl('https://pl.playlist6.space/playlist/57083/other_backend/caxi','57083','playlist'),false);
  for (const bad of [root.replace('https:','http:'),root.replace('hereisman.net','hereisman.net.attacker.test'),
    root.replace('https://','https://user@'),root.replace('hereisman.net','hereisman.net:8443'),`${root}#part`])
    assert.equal(validGoozResourceUrl(bad,'57069','playlist'),false);
  assert.equal(validGoozResourceUrl(variant,'57068','playlist'),false);
  assert.equal(validGoozResourceUrl(media,'57068','media'),false);
  for (const bad of [media.replace('r2.cloudflarestorage.com','r2.cloudflarestorage.com.attacker.test'),
    media.replace('.r2.cloudflarestorage.com','.extra.r2.cloudflarestorage.com'),
    media.replace('https://','https://user@'),media.replace('r2.cloudflarestorage.com','r2.cloudflarestorage.com:8443'),
    media.replace('NTcwNjk%3D','NTcwNjk%253D'),media.replace('X-Amz-Signature=','X-Amz-Signature=oops&X-Amz-Signature='),
    media.replace('a'.repeat(64),'short')]) assert.equal(validGoozResourceUrl(bad,'57069','media'),false);
});

test('relay rewrites only resources resolved by the provider and scopes tokens to generations',()=>{
  const first=grant('11111111-1111-4111-8111-111111111111');
  const rootResource=goozResource(root,'57069','playlist');
  assert.ok(rootResource);
  const rewritten=rewritePlaylist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n${variant}\n`,rootResource,first);
  const token=/\/api\/stream\/media\/([a-f0-9]{48})/.exec(rewritten)?.[1];
  assert.ok(token);
  const child=registeredResource(token);
  assert.equal(child?.kind,'playlist');
  assert.equal(child?.resource.identity,variant);
  const variantResource=goozResource(variant,'57069','playlist');
  assert.ok(variantResource);
  const rewrittenMedia=rewritePlaylist(`#EXTM3U\n#EXTINF:5,\n${media}\n#EXT-X-MAP:URI="${media}"\n`,variantResource,first);
  const mediaTokens=[...rewrittenMedia.matchAll(/\/api\/stream\/media\/([a-f0-9]{48})/g)].map(match=>match[1]);
  assert.equal(mediaTokens.length,2);
  assert.equal(mediaTokens[0],mediaTokens[1]);
  assert.throws(()=>rewritePlaylist('#EXTM3U\nhttps://attacker.test/segment.ts',variantResource,first));
  const rotated=variantResource.resolve(media.replace('a'.repeat(64),'b'.repeat(64)),'media');
  assert.ok(rotated);
  assert.equal(registerResource(first,rotated),mediaTokens[0]);
  const newer=registerResource(grant(first.sessionId,1),rotated);
  assert.notEqual(newer,mediaTokens[0]);
  const oldSignal=streamSignal(first);
  const nextSignal=streamSignal(grant(first.sessionId,1));
  revokeGeneration(first.sessionId,1);
  assert.equal(oldSignal.aborted,true);
  assert.equal(nextSignal.aborted,false);
  assert.equal(registeredResource(mediaTokens[0]),null);
  assert.ok(registeredResource(newer));
  revokeSession(first.sessionId);
  assert.equal(nextSignal.aborted,true);
  assert.equal(registeredResource(newer),null);
});

test('Streamcenter resource grammar binds signed manifest and segments to one stream and host',()=>{
  const session={stream:'lmdsjkfgv52',host:'edgestream4.pro',referer:'https://streame.center/embed/hls.php?stream=lmdsjkfgv52',fetcher:fetch};
  const manifest=`https://edgestream4.pro/hls/lmdsjkfgv52.m3u8?st=${'a'.repeat(32)}&e=${Math.floor(Date.now()/1000)+3600}`;
  const segment='https://edgestream4.pro/hls/lmdsjkfgv52-907340670.ts';
  assert.equal(validStreamcenterResourceUrl(manifest,session,'playlist'),true);
  assert.equal(validStreamcenterResourceUrl(segment,session,'media'),true);
  const firstHost={...session,host:'edgestream1.pro'};
  const firstManifest=manifest.replace('edgestream4.pro','edgestream1.pro');
  const firstSegment=segment.replace('edgestream4.pro','edgestream1.pro');
  assert.equal(validStreamcenterResourceUrl(firstManifest,firstHost,'playlist'),true);
  assert.equal(validStreamcenterResourceUrl(firstSegment,firstHost,'media'),true);
  assert.equal(validStreamcenterResourceUrl(firstManifest,session,'playlist'),false);
  const rootResource=streamcenterResource(manifest,session,'playlist');
  assert.ok(rootResource);
  assert.ok(rootResource.resolve('/hls/lmdsjkfgv52-907340670.ts','media'));
  for (const bad of [manifest.replace('https:','http:'),manifest.replace('edgestream4.pro','edgestream4.pro.attacker.test'),
    manifest.replace('https://','https://user@'),manifest.replace('edgestream4.pro/','edgestream4.pro:8443/'),
    manifest.replace('st=','st=oops&st='),manifest.replace('lmdsjkfgv52.m3u8','other.m3u8')])
    assert.equal(validStreamcenterResourceUrl(bad,session,'playlist'),false);
  for (const bad of [segment.replace('edgestream4.pro','edgestream5.pro'),segment.replace('lmdsjkfgv52-','other-'),
    segment+'?x=1',segment.replace('.ts','.m3u8')]) assert.equal(validStreamcenterResourceUrl(bad,session,'media'),false);
});

test('Streamcenter opens published public link once, then reads signed HLS with scoped headers',async()=>{
  const linkId='aef974e2-5ef2-412c-b65e-e6905af1edfa';
  const publicUrl=`https://streamcenter.st/api/stream-link/iframe/event-espn-league-football-college-football-401856699/${linkId}`;
  const player='https://streame.center/embed/ch52.php';
  const hls='https://streame.center/embed/hls.php?stream=lmdsjkfgv52';
  const manifest=`https://edgestream1.pro/hls/lmdsjkfgv52.m3u8?st=${'a'.repeat(32)}&e=${Math.floor(Date.now()/1000)+3600}`;
  const segment='https://edgestream1.pro/hls/lmdsjkfgv52-907340670.ts';
  const requests:{url:string;referer:string|null;origin:string|null;range:string|null}[]=[];
  const fetcher:typeof fetch=async (input,init)=>{
    const url=String(input);
    const headers=new Headers(init?.headers);
    requests.push({url,referer:headers.get('referer'),origin:headers.get('origin'),range:headers.get('range')});
    if (url===publicUrl) return new Response(null,{status:302,headers:{Location:player}});
    if (url===player) return new Response(`<iframe src="//streame.center/embed/hls.php?stream=lmdsjkfgv52"></iframe>`);
    if (url===hls) return new Response(`<script>const streamUrl = ${JSON.stringify(manifest).replace('&','\\u0026')};</script>`);
    if (url===manifest) return new Response(`#EXTM3U\n#EXTINF:5,\n/hls/lmdsjkfgv52-907340670.ts\n`,{headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
    if (url===segment) return new Response(new Uint8Array([0x47,0,0]),{status:206,headers:{'Content-Type':'video/mp2t','Content-Range':'bytes 0-2/3'}});
    throw new Error('unexpected request');
  };
  const provider=streamcenterProvider(fetcher);
  const playback=await provider.open({provider:'streamcenter',eventId:'401856699',linkId},new AbortController().signal);
  const rootRead=await playback.root.read({signal:new AbortController().signal});
  assert.equal(rootRead.status,200);
  const body=await new Response(rootRead.body).text();
  const childPath=body.split('\n').find(line=>line.endsWith('.ts'));
  assert.ok(childPath);
  const child=playback.root.resolve(childPath,'media');
  assert.ok(child);
  const mediaRead=await child.read({signal:new AbortController().signal,range:'bytes=0-2'});
  assert.equal(mediaRead.status,206);
  assert.equal(requests.length,5);
  assert.equal(requests[2].referer,player);
  assert.equal(requests[3].origin,'https://streame.center');
  assert.equal(requests[4].range,'bytes=0-2');
  assert.equal(requests[4].referer,hls);
  playback.close();
});

test('Streamcenter opens a published hls2 player with its exact parent Referer',async()=>{
  const linkId='aef974e2-5ef2-412c-b65e-e6905af1edfa';
  const publicUrl=`https://streamcenter.st/api/stream-link/iframe/event-espn-league-football-college-football-401858469/${linkId}`;
  const player='https://streame.center/embed/ch85.php';
  const hls='https://streame.center/embed/hls2.php?stream=jkhfsgqghjqsd85';
  const manifest=`https://edgestream3.pro/hls/jkhfsgqghjqsd85.m3u8?st=${'a'.repeat(32)}&e=${Math.floor(Date.now()/1000)+3600}`;
  const requests:{url:string;referer:string|null}[]=[];
  const fetcher:typeof fetch=async (input,init)=>{
    const url=String(input);
    requests.push({url,referer:new Headers(init?.headers).get('referer')});
    if (url===publicUrl) return new Response(null,{status:302,headers:{Location:player}});
    if (url===player) return new Response('<iframe src="//streame.center/embed/hls2.php?stream=jkhfsgqghjqsd85"></iframe>');
    if (url===hls) return new Response(`<script>const streamUrl = ${JSON.stringify(manifest)};</script>`);
    if (url===manifest) return new Response('#EXTM3U\n#EXTINF:5,\n/hls/jkhfsgqghjqsd85-907340670.ts\n');
    throw new Error(`Unexpected request: ${url}`);
  };
  const playback=await streamcenterProvider(fetcher).open({provider:'streamcenter',eventId:'401858469',linkId},new AbortController().signal);
  const read=await playback.root.read({signal:new AbortController().signal});
  assert.equal(read.status,200);
  assert.deepEqual(requests.map(request=>request.url),[publicUrl,player,hls,manifest]);
  assert.equal(requests[2].referer,player);
  assert.equal(requests[3].referer,hls);
  playback.close();
});

test('one opening is shared, revoked late opening closes once, and a failed opening can retry',async()=>{
  const sessionId='22222222-2222-4222-8222-222222222222';
  const g=grant(sessionId);
  const locator={provider:'gooz' as const,playerId:'57069'};
  let opened=0;
  let closed=0;
  let release:(playback:{root:ProviderResource;close:()=>void})=>void=()=>{};
  const rootResource=goozResource(root,'57069','playlist');
  assert.ok(rootResource);
  const opener=async()=>{opened++;return new Promise<{root:ProviderResource;close:()=>void}>(resolve=>{release=resolve;});};
  const first=openGeneration(g,locator,new AbortController().signal,opener);
  const second=openGeneration(g,locator,new AbortController().signal,opener);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(opened,1);
  revokeSession(sessionId);
  release({root:rootResource,close:()=>{closed++;}});
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(closed,1);
  assert.equal(resourceCount()>=0,true);
  const retryGrant=grant('33333333-3333-4333-8333-333333333333');
  await assert.rejects(openGeneration(retryGrant,locator,new AbortController().signal,async()=>{throw new Error('offline');}));
  const recovered=await openGeneration(retryGrant,locator,new AbortController().signal,async()=>({root:rootResource,close:()=>{closed++;}}));
  assert.equal(recovered.root.kind,'playlist');
  revokeSession(retryGrant.sessionId);
  assert.equal(closed,2);
});

test('aborting one request leaves another waiter on the same generation opening',async()=>{
  const sessionId='55555555-5555-4555-8555-555555555555';
  const g=grant(sessionId);
  const locator={provider:'gooz' as const,playerId:'57069'};
  const resource=goozResource(root,'57069','playlist');
  assert.ok(resource);
  let opens=0;
  let closes=0;
  let release:(playback:{root:ProviderResource;close:()=>void})=>void=()=>{};
  const opener=async()=>{opens++;return new Promise<{root:ProviderResource;close:()=>void}>(resolve=>{release=resolve;});};
  const firstController=new AbortController();
  const first=openGeneration(g,locator,firstController.signal,opener);
  const secondController=new AbortController();
  const second=openGeneration(g,locator,secondController.signal,opener);
  await new Promise<void>(resolve=>setImmediate(resolve));
  firstController.abort();
  await assert.rejects(first,/Stream request ended/);
  assert.equal(secondController.signal.aborted,false);
  release({root:resource,close:()=>{closes++;}});
  const playback=await second;
  assert.equal(opens,1);
  assert.equal(playback.root.identity,root);
  revokeSession(sessionId);
  assert.equal(closes,1);
});

test('lease cleanup, range validation, and browser summaries retain no provider locator',()=>{
  for (const good of ['bytes=0-375','bytes=10-','bytes=-500']) assert.equal(validByteRange(good),true);
  for (const bad of ['bytes=-','bytes=10-1','bytes=-0','bytes=0-1,5-6','bytes=abc-def']) assert.equal(validByteRange(bad),false);
  const g=grant('44444444-4444-4444-8444-444444444444');
  const resource=goozResource(variant,'57069','playlist');
  assert.ok(resource);
  const token=registerResource(g,resource);
  const started=Date.now();
  touchStreamSession(g.sessionId,g.generation,started+60_000);
  expireIdleStreams(started+61_000);
  assert.ok(registeredResource(token));
  expireIdleStreams(started+181_000);
  assert.equal(registeredResource(token),null);
  const candidate=CandidateSchema.parse({id:'gooz-57069',gameId:g.gameId,label:'Primary',sourceIds:['sportsurge'],
    observedAt:started,locator:{provider:'gooz',playerId:'57069'}});
  const summary=candidateSummary(candidate);
  assert.equal('locator' in summary,false);
  const playback=PlaybackSchema.parse({session:{id:g.sessionId,gameId:g.gameId,candidateId:candidate.id,generation:0,state:'active',graceEndsAt:null},
    candidates:[summary]});
  assert.equal(JSON.stringify(playback).includes('playerId'),false);
  revokeSession(g.sessionId);
});
