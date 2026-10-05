import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {swacProvider} from '../lib/playback/providers/swac.ts';
import {swacApiUrl} from '../lib/playback/providers/swac-catalog.ts';
import type {Requester} from '../lib/playback/providers/public-page.ts';

const event=JSON.parse(readFileSync(new URL('./fixtures/swac/live-event.json',import.meta.url),'utf8'));
const locator={provider:'swac' as const,eventId:event.id};
const asset=Buffer.from(JSON.stringify({url:'https://live.gideo.video/brutus/swac-live5/index-1791032400-57600.m3u8',beg:1791068400})).toString('base64url');
const master=`https://live-vod.gideo.video/livedvr/${asset}/master.m3u8`;
const segment='https://live.gideo.video/brutus/swac-live5/tracks-v3a1/dvr-2026/10/04/02/03/02-05255.ts';
const media={videoId:event.id,urls:[{streamFormat:'hls',url:master}]};
const signal=()=>AbortSignal.timeout(1000);
const requester=(metadata=event,body=media):Requester=>async(url,_signal,headers)=>{
  assert.equal(headers.has('Cookie'),false);assert.equal(headers.has('Authorization'),false);
  if(url.href===swacApiUrl('getVideo',event.id))return Response.json(metadata);
  if(url.href===swacApiUrl('getVideoUrls',event.id))return Response.json(body);
  return new Response(url.href===segment?'segment':'#EXTM3U\n',{status:200});
};

test('SWAC opens anonymous event media and confines its cross-host DVR graph',async()=>{
  const playback=await swacProvider(requester()).open(locator,signal());
  assert.equal(playback.root.identity,master);
  const variant=playback.root.resolve('0','playlist');assert.ok(variant);
  assert.ok(variant.resolve(segment,'media'));
  const child=variant.resolve(segment,'media');assert.ok(child);
  assert.equal((await child.read({signal:signal(),range:'bytes=0-187'})).status,200);
  for(const url of [segment.replace('swac-live5','swac-live4'),segment.replace('live.gideo.video','live.gideo.video.attacker.test'),
    segment.replace('https:','http:'),segment+'?token=other',segment+'#other','https://127.0.0.1/video.ts'])assert.equal(variant.resolve(url,'media'),null,url);
  assert.equal(playback.root.resolve(master.replace(asset,'different'),'playlist'),null);
  await assert.rejects(child.read({signal:signal(),range:'bytes=0-1,3-4'}),/range/);
});

test('SWAC rechecks access, event identity and kickoff-bound published media on open',async()=>{
  for(const metadata of [{...event,live:false},{...event,freeBehavior:'subscribe'},{...event,id:'f'.repeat(32)},
    {...event,title:event.title.replace('Football','Volleyball')},
    {...event,title:'Football (10/3/99) Arkansas Pine-Bluff vs Southern',description:'October 3, 2099 | 6:00 PM CT',goLiveTime:'2099-10-03T22:50:00Z'}])await assert.rejects(swacProvider(requester(metadata)).open(locator,signal()));
  for(const body of [{...media,videoId:'f'.repeat(32)},
    {...media,urls:[{streamFormat:'hls',url:master.replace(asset,Buffer.from(JSON.stringify({url:'https://live.gideo.video/brutus/swac-live5/index-1-2.m3u8',beg:1})).toString('base64url'))}]},
    {...media,urls:[{streamFormat:'hls',url:master.replace('live-vod.gideo.video','attacker.test')}]}])await assert.rejects(swacProvider(requester(event,body)).open(locator,signal()));
});

test('SWAC media redirects cannot leave the bound event graph and preserve ranges',async()=>{
  let cancelled=false;
  const base=requester();
  const transport:Requester=async(url,active,headers,timeout)=>{
    if(url.hostname==='ott.gideo.video')return base(url,active,headers,timeout);
    assert.equal(headers.get('Range'),'bytes=10-');
    return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:302,headers:{Location:segment.replace('swac-live5','swac-live4')}});
  };
  const playback=await swacProvider(transport).open(locator,signal());
  await assert.rejects(playback.root.read({signal:signal(),range:'bytes=10-'}),/redirect/);
  assert.equal(cancelled,true);
});

test('SWAC follows same-event redirects and preserves byte ranges',async()=>{
  const base=requester();let calls=0;
  const transport:Requester=async(url,active,headers,timeout)=>{
    if(url.hostname==='ott.gideo.video')return base(url,active,headers,timeout);
    assert.equal(headers.get('Range'),'bytes=-188');assert.equal(active.aborted,false);
    calls++;
    return url.href===master ? new Response(null,{status:302,headers:{Location:'0'}}) : new Response('#EXTM3U\n',{status:206,headers:{'content-range':'bytes 0-7/8'}});
  };
  const playback=await swacProvider(transport).open(locator,signal());
  const result=await playback.root.read({signal:signal(),range:'bytes=-188'});
  assert.equal(result.status,206);assert.equal(result.contentRange,'bytes 0-7/8');assert.equal(calls,2);
});
