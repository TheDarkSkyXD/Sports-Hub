import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {probeCandidate} from '../lib/playback/probe.ts';
import {streamcenterProvider,validStreamcenterResourceUrl} from '../lib/playback/providers/streamcenter.ts';
import {parseStreamcenterPlayer} from '../lib/playback/providers/streamcenter-player.ts';

test('captured-shape Streamcenter ch30 uppercase token reaches case-matched playable media',async()=>{
  const html=readFileSync(new URL('./fixtures/streamcenter-ch30-uppercase.html',import.meta.url),'utf8');
  const stream='AbC123def456GH';
  const linkId='aef974e2-5ef2-412c-b65e-e6905af1edfa';
  const locator={provider:'streamcenter' as const,eventId:'401871051',linkId};
  const publicUrl=`https://streamcenter.st/api/stream-link/iframe/event-espn-league-football-college-football-${locator.eventId}/${linkId}`;
  const parent='https://streame.center/embed/ch30.php';
  const hls=`https://streame.center/embed/hls.php?stream=${stream}`;
  const manifest=`https://edgestream7.pro/hls/${stream}.m3u8?st=${'a'.repeat(32)}&e=${Math.floor(Date.now()/1000)+3600}`;
  const segment=`https://edgestream7.pro/hls/${stream}-907340670.ts`;
  const media=Buffer.alloc(188*4);
  for(let offset=0;offset<media.length;offset+=188)media[offset]=0x47;
  assert.deepEqual(parseStreamcenterPlayer(html),{stream,url:hls});
  assert.equal(validStreamcenterResourceUrl(manifest,{stream,host:'edgestream7.pro'},'playlist'),true);
  assert.equal(validStreamcenterResourceUrl(manifest,{stream:stream.toLowerCase(),host:'edgestream7.pro'},'playlist'),false);
  const requests:{url:string;referer:string|null;origin:string|null}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);
    const headers=new Headers(init?.headers);
    requests.push({url,referer:headers.get('referer'),origin:headers.get('origin')});
    if(url===publicUrl)return new Response(null,{status:302,headers:{Location:parent}});
    if(url===parent)return new Response(html,{headers:{'Content-Type':'text/html'}});
    if(url===hls)return new Response(`<script>const streamUrl = ${JSON.stringify(manifest)};</script>`);
    if(url===manifest)return new Response(`#EXTM3U\n#EXTINF:5,\n/hls/${stream}-907340670.ts\n`,
      {headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
    if(url===segment)return new Response(media,{headers:{'Content-Type':'video/mp2t'}});
    throw new Error('unexpected Streamcenter request');
  };
  const provider=streamcenterProvider(fetcher);
  const result=await probeCandidate(locator,new AbortController().signal,(candidate,signal)=>{
    if(candidate.provider!=='streamcenter')throw new Error('unexpected provider');
    return provider.open(candidate,signal);
  });
  assert.deepEqual(result,{kind:'playable',proof:'media'});
  assert.deepEqual(requests.map(request=>request.url),[publicUrl,parent,hls,manifest,segment]);
  assert.equal(requests[2].referer,parent);
  assert.equal(requests[3].origin,'https://streame.center');
  assert.equal(requests[4].referer,hls);
});
