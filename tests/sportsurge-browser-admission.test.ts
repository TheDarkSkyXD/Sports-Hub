import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {sportsurgeV2Provider} from '../lib/playback/providers/sportsurge-v2.ts';

for(const kind of ['hls','progressive'] as const)test('generic Sportsurge HTML publishes only browser-owned '+kind+' through its captured session',async()=>{
  const media=kind==='hls'?'https://cdn.example/game.m3u8':'https://cdn.example/game.mp4';
  const messages:{path:string|undefined;body:Record<string,string>}[]=[];
  const server=createServer(async(request,response)=>{
    const parts:Buffer[]=[];for await(const part of request)parts.push(part);
    const body=parts.length?JSON.parse(Buffer.concat(parts).toString()):{};messages.push({path:request.url,body});
    if(request.url==='/observe')response.end(JSON.stringify({...(kind==='progressive'?{kind}:{}),url:media,referer:'https://selected.example/player',userAgent:'Captured Chromium',capability:'11111111-1111-4111-8111-111111111111'}));
    else if(request.url==='/media'){response.writeHead(body.range?206:200,{'content-type':kind==='hls'?'application/vnd.apple.mpegurl':'video/mp4'});response.end(kind==='hls'?'#EXTM3U\n':'captured video');}
    else{response.statusCode=204;response.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  const prior=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN,token=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN='http://127.0.0.1:'+address.port;process.env.SUNDAY_ROOM_CONTROL_TOKEN='fixture';
  let reads=0;
  try{
    const url='https://source.example/event';
    const playback=await sportsurgeV2Provider(async target=>{reads++;assert.equal(target.href,url);return new Response('<title>Generic player</title><video src="https://cdn.example/advert.mp4"></video>',{headers:{'content-type':'text/html'}});})
      .open({provider:'sportsurge-v2',eventId:'mlb:1',providerId:'one',url},new AbortController().signal);
    try{
      assert.equal(reads,1);assert.equal(playback.root?.kind,kind==='hls'?'playlist':'media');assert.equal(playback.root?.identity,media);assert.ok(playback.root);
      const read=await playback.root.read({signal:new AbortController().signal,...(kind==='progressive'?{range:'bytes=0-'}:{})});
      assert.equal(await new Response(read.body).text(),kind==='hls'?'#EXTM3U\n':'captured video');
      assert.deepEqual(messages.slice(0,2),[{path:'/observe',body:{url,purpose:'playback'}},{path:'/media',body:{capability:'11111111-1111-4111-8111-111111111111',url:media,...(kind==='progressive'?{range:'bytes=0-'}:{})}}]);
    }finally{playback.close();}
  }finally{
    if(prior===undefined)delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=prior;
    if(token===undefined)delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;else process.env.SUNDAY_ROOM_CONTROL_TOKEN=token;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

const entry={provider:'sportsurge-v2' as const,eventId:'ncaaf:1',providerId:'one',url:'https://provider.example/game'};
for(const [shape,html] of Object.entries({
  hidden:'<div hidden><iframe src="https://cdn.example/advert.m3u8"></iframe></div>',
  inlineHidden:'<iframe style="display:none" src="https://cdn.example/advert.m3u8"></iframe>',
  template:'<template><iframe src="https://cdn.example/advert.m3u8"></iframe></template>',
  details:'<details><iframe src="https://cdn.example/advert.m3u8"></iframe></details>',
  nested:'<iframe src="https://provider.example/nested"></iframe>',
}))test('iframe-discovered HLS '+shape+' never bypasses browser ownership',async()=>{
  const observed:string[]=[];
  const playback=await sportsurgeV2Provider(async url=>new Response(url.pathname.endsWith('.m3u8')?'#EXTM3U\n':
    url.pathname==='/nested'?'<iframe src="https://cdn.example/advert.m3u8"></iframe>':html,
    {headers:{'content-type':url.pathname.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'text/html'}}),async url=>{
      observed.push(url.href);
      return {root:{kind:'playlist',identity:'https://cdn.example/owned-game.m3u8',async read(){throw new Error('Unexpected read');},resolve(){return null;}},close(){}};
    }).open(entry,new AbortController().signal);
  try{assert.deepEqual(observed,[entry.url]);assert.equal(playback.root?.identity,'https://cdn.example/owned-game.m3u8');}finally{playback.close();}
});

test('a directly published HLS entry including an HTTP redirect stays on the HTTP path',async()=>{
  let observed=0;
  const playback=await sportsurgeV2Provider(async url=>url.href===entry.url?new Response(null,{status:302,headers:{location:'https://cdn.example/owned-game.m3u8'}}):
    new Response('#EXTM3U\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}}),async()=>{observed++;return null;})
    .open(entry,new AbortController().signal);
  try{assert.equal(observed,0);assert.equal(playback.root?.identity,'https://cdn.example/owned-game.m3u8');}finally{playback.close();}
});
