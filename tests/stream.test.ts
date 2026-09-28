import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandidateSchema, PlaybackSchema, candidateSummary } from '../lib/football/shared.ts';
import { goozResource, goozSourceFromEmbed, validGoozResourceUrl } from '../lib/playback/providers/gooz.ts';
import { streamcenterProvider, streamcenterResource, validStreamcenterResourceUrl } from '../lib/playback/providers/streamcenter.ts';
import { parseStreamcenterPlayer } from '../lib/playback/providers/streamcenter-player.ts';
import type { ProviderResource } from '../lib/playback/provider.ts';
import { expireIdleStreams, openGeneration, registeredResource, registerResource, resourceCount, revokeGeneration, revokeSession,
  rewritePlaylist, streamSignal, touchStreamSession, validByteRange } from '../lib/stream-relay.ts';

const grant=(sessionId:string,generation=0)=>({sessionId,candidateId:'gooz-57069',generation,gameId:'ncaaf-401858468'});
const root='https://chatgpt.hereisman.net/playlist/57069/load-playlist';
const variant='https://pl.playlist3.space/playlist/57069/proton1/caxi';
const media=`https://proton1.2f4049362e3069c1dbb69a47b280e76a.r2.cloudflarestorage.com/scripts/NTcwNjk%3D/segment.txt?X-Amz-Signature=${'a'.repeat(64)}`;

test('live relay keeps segment URLs stable while refreshing upstream signatures',async()=>{
  const owner=grant('rotating-live-signatures');
  const resource=(identity:string,kind:'playlist'|'media'='playlist'):ProviderResource=>({
    identity,kind,
    async read(){return {status:200,body:new Response(identity).body};},
    resolve(reference,expected){return resource(new URL(reference,identity).href,expected);},
  });
  const playlist=resource('https://provider.test/live.m3u8');
  const text=(sequence:number,signature:string)=>`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:4,\n${sequence}.ts?sig=${signature}\n#EXTINF:4,\n${sequence+1}.ts?sig=${signature}\n`;
  const tokens=(body:string)=>[...body.matchAll(/\/api\/stream\/media\/([a-f0-9]{48})/g)].map(match=>match[1]);
  try {
    const first=tokens(rewritePlaylist(text(611,'old'),playlist,owner));
    const next=tokens(rewritePlaylist(text(612,'fresh'),playlist,owner));
    assert.equal(next[0],first[1]);
    assert.notEqual(next[1],first[1]);
    const refreshed=registeredResource(first[1]);
    assert.ok(refreshed);
    const read=await refreshed.resource.read({signal:AbortSignal.timeout(1000)});
    assert.equal(await new Response(read.body).text(),'https://provider.test/612.ts?sig=fresh');
    const other=tokens(rewritePlaylist(text(612,'fresh'),resource('https://provider.test/other.m3u8'),owner));
    assert.notEqual(other[0],next[0]);
    const ranged=tokens(rewritePlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:612\n#EXTINF:4,\n#EXT-X-BYTERANGE:100@0\nshared.ts\n#EXTINF:4,\n#EXT-X-BYTERANGE:100\nshared.ts\n',playlist,owner));
    assert.equal(ranged[0],ranged[1]);
    const newer=tokens(rewritePlaylist(text(612,'fresh'),playlist,grant(owner.sessionId,1)));
    assert.notEqual(newer[0],next[0]);
    revokeGeneration(owner.sessionId,1);
    assert.equal(registeredResource(next[0]),null);
    assert.ok(registeredResource(newer[0]));
  } finally {revokeSession(owner.sessionId);}
});

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

test('Gooz relays published quality variants with dotted backend names',()=>{
  const owner=grant('775e74ac-9bae-4746-b902-43e365db1a41');
  const resource=goozResource(root,'57069','playlist');
  assert.ok(resource);
  const variants=[
    'https://pl.playlist5.space/playlist/57069/pl.goozekhar1.space/caxi-low',
    'https://pl.goozekhar2.space/playlist/57069/red.redirector1.space/caxi',
    'https://pl.playlist6.space/playlist/57069/pl.kamfir3.space/caxi-fhd',
  ];
  try {
    const rewritten=rewritePlaylist(`#EXTM3U\n${variants.map(url=>`#EXT-X-STREAM-INF:BANDWIDTH=4000000\n${url}`).join('\n')}\n`,resource,owner);
    const tokens=[...rewritten.matchAll(/\/api\/stream\/media\/([a-f0-9]{48})/g)].map(match=>match[1]);
    assert.equal(tokens.length,3);
    assert.deepEqual(tokens.map(token=>registeredResource(token)?.resource.identity),variants);
    for (const bad of [variants[0].replace('/57069/','/57068/'),variants[0].replace('caxi-low','caxi-other'),
      variants[0].replace('pl.goozekhar1.space','pl..space'),`${variants[0]}?url=https://example.com`,
      variants[0].replace('https://pl.playlist5.space/','https://attacker.test/')])
      assert.equal(resource.resolve(bad,'playlist'),null);
  } finally { revokeSession(owner.sessionId); }
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

test('Gooz resolves published NFL redirect segments without forwarding embed headers',async()=>{
  const target='https://o300801-mp-lura-live.fsy.nfl.com/live/ephemeral/game/dmla-anvato01/1128k/stream/176176/segment_176176827c.ts?token=sample';
  const wrapped=`https://pl.goozekhar1.space/redirect/video-1segment_176176827c.txt?path=${encodeURIComponent(target)}`;
  const requests:{url:string;headers:Headers;redirect:RequestRedirect|undefined}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    requests.push({url:String(input),headers:new Headers(init?.headers),redirect:init?.redirect});
    return new Response(new Uint8Array([71,64,17]),{status:200,headers:{'content-type':'video/MP2T'}});
  };
  const playlist=goozResource('https://pl.playlist5.space/playlist/57069/pl.goozekhar1.space/caxi-low','57069','playlist',fetcher);
  assert.ok(playlist);
  const segment=playlist.resolve(wrapped,'media');
  assert.ok(segment);
  const response=await segment.read({signal:new AbortController().signal,range:'bytes=0-2'});
  assert.deepEqual([...new Uint8Array(await new Response(response.body).arrayBuffer())],[71,64,17]);
  assert.equal(requests[0].url,target);
  assert.equal(requests[0].redirect,'manual');
  assert.equal(requests[0].headers.get('range'),'bytes=0-2');
  assert.equal(requests[0].headers.get('referer'),null);
  assert.equal(requests[0].headers.get('origin'),null);
  assert.equal(segment.identity.includes('token='),false);
  for(const bad of [wrapped.replace('https://pl.goozekhar1.space/','https://attacker.test/'),
    wrapped.replace('video-1segment_176176827c','video-1segment_1'),
    wrapped.replace(encodeURIComponent(target),encodeURIComponent(target.replace('fsy.nfl.com','attacker.test'))),
    wrapped.replace(encodeURIComponent(target),encodeURIComponent(target.replace('https://','http://'))),
    wrapped.replace(encodeURIComponent(target),encodeURIComponent(target.replace('/live/ephemeral/','/private/'))),
    `${wrapped}&path=${encodeURIComponent(target)}`]) assert.equal(playlist.resolve(bad,'media'),null);
});

test('Gooz resolves Akamai NFL segments for primary and backup quality variants',async()=>{
  const target='https://o300801-mp-lura-live.akamaized.net/live/ephemeral/game/dmla-anvato12/1128k/stream/174224/segment_174224780c.ts?hdntl=exp%3D1790549999~acl%3D%2F*~hmac%3Dabc';
  const requests:string[]=[];
  const fetcher:typeof fetch=async input=>{
    requests.push(String(input));
    return new Response(new Uint8Array([71,64,17]),{status:200,headers:{'content-type':'video/MP2T'}});
  };
  for(const [playerId,backend,quality] of [
    ['57314','red.redirector1.space','caxi-low'],
    ['57315','pl.kamfir4.space','caxi-fhd'],
  ] as const){
    const playlist=goozResource(`https://pl.playlist5.space/playlist/${playerId}/${backend}/${quality}`,
      playerId,'playlist',fetcher);
    assert.ok(playlist);
    for(const video of [1,3,5]){
      const wrapped=`https://${backend}/redirect/video-${video}segment_174224780c.txt?path=${encodeURIComponent(target)}`;
      const segment=playlist.resolve(wrapped,'media');
      assert.ok(segment);
      assert.equal(segment.identity,target.split('?')[0]);
      await segment.read({signal:new AbortController().signal});
      for(const bad of [
        target.replace('akamaized.net','akamaized.net.attacker.test'),
        target.replace('hdntl=','token='),
        target.replace('segment_174224780c.ts','segment_174224780d.ts'),
        target.replace('/live/ephemeral/','/private/'),
        `${target}&hdntl=duplicate`,
      ]) assert.equal(playlist.resolve(wrapped.replace(encodeURIComponent(target),encodeURIComponent(bad)),'media'),null);
    }
  }
  assert.equal(requests.length,6);
  assert.ok(requests.every(url=>url===target));
});

test('Gooz relays published NFL 720p and 1080p segment wrappers',()=>{
  const owner=grant('fd51259f-844d-4254-a733-b4ed328762e4');
  try {
    for (const [variantName,wrapperNumber,bitrate] of [['caxi','3','5128k'],['caxi-fhd','5','8128k']]) {
      const playlist=goozResource(`https://pl.playlist3.space/playlist/57069/pl.goozekhar1.space/${variantName}`,'57069','playlist');
      assert.ok(playlist);
      const target=`https://o300801-mp-lura-live.fsy.nfl.com/live/ephemeral/game/dmla-anvato01/${bitrate}/stream/176176/segment_176176827c.ts?token=sample`;
      const wrapped=`https://pl.goozekhar1.space/redirect/video-${wrapperNumber}segment_176176827c.txt?path=${encodeURIComponent(target)}`;
      const rewritten=rewritePlaylist(`#EXTM3U\n#EXTINF:6,\n${wrapped}\n`,playlist,owner);
      const token=/\/api\/stream\/media\/([a-f0-9]{48})/.exec(rewritten)?.[1];
      assert.ok(token);
      assert.equal(registeredResource(token)?.resource.identity,target.split('?')[0]);
      assert.equal(playlist.resolve(wrapped.replace(`video-${wrapperNumber}segment_176176827c`,'video-2segment_176176827c'),'media'),null);
      assert.equal(playlist.resolve(wrapped.replace('segment_176176827c.ts','segment_176176828c.ts'),'media'),null);
    }
  } finally { revokeSession(owner.sessionId); }
});

test('Streamcenter player parser accepts only published exact HLS iframe URLs',()=>{
  assert.deepEqual(parseStreamcenterPlayer('<iframe src="//streame.center/embed/hls.php?stream=lmdsjkfgv52"></iframe>'),
    {stream:'lmdsjkfgv52',url:'https://streame.center/embed/hls.php?stream=lmdsjkfgv52'});
  assert.deepEqual(parseStreamcenterPlayer('<iframe src="https://streame.center/embed/hls2.php?stream=jkhfsgqghjqsd85"></iframe>'),
    {stream:'jkhfsgqghjqsd85',url:'https://streame.center/embed/hls2.php?stream=jkhfsgqghjqsd85'});
  for (const bad of [
    'http://streame.center/embed/hls2.php?stream=abc',
    'https://streame.center.evil.test/embed/hls2.php?stream=abc',
    'https://user@streame.center/embed/hls2.php?stream=abc',
    'https://streame.center:443/embed/hls2.php?stream=abc',
    'https://streame.center/embed/hls3.php?stream=abc',
    'https://streame.center/embed/hls2.php?stream=abc&stream=def',
    'https://streame.center/embed/hls2.php?stream=abc&other=1',
    'https://streame.center/embed/hls2.php?stream=abc#fragment',
  ]) assert.equal(parseStreamcenterPlayer(`<iframe src="${bad}"></iframe>`),null,bad);
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
