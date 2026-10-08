import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {publishedFootballMatchup} from '../lib/playback/providers/sportsurge-matchup.ts';
import {sportsurgeV2Provider} from '../lib/playback/providers/sportsurge-v2.ts';

const source='https://dudestream1.com/abc1234';
const parent='https://dudestream1.com/cfb96/';
const player='https://embedsports.me/american-football/jacksonville-state-vs-kennesaw-state-stream-1';
const wrongPlayer='https://embedsports.me/american-football/troy-trojans-vs-kennesaw-state-owls-stream-1';
const expectedMatchup={league:'ncaaf' as const,teams:['Jacksonville State Gamecocks','Kennesaw State Owls'] as const};
const locator={provider:'sportsurge-v2' as const,eventId:'ncaaf:66184',providerId:'stream-1-0',url:source,expectedMatchup};
const parentHtml=(title:string,frames:string[],canonical=parent)=>`<html><head><title>${title}</title>
  <link rel="canonical" href="${canonical}"></head><body>${frames.map(frame=>`<iframe src="${frame}"></iframe>`).join('')}</body></html>`;
const playerHtml=(title:string)=>`<html><head><title>${title}</title></head><body>player</body></html>`;

test('NCAA title evidence distinguishes exact, conflicting, and unknown identities',()=>{
  assert.equal(publishedFootballMatchup(expectedMatchup,'Jacksonville State vs Kennesaw State – Dudestream'),'matches');
  assert.equal(publishedFootballMatchup(expectedMatchup,'Kennesaw St at Jax State'),'matches');
  assert.equal(publishedFootballMatchup(expectedMatchup,'Troy Trojans vs Kennesaw State Owls'),'conflicting');
  assert.equal(publishedFootballMatchup(expectedMatchup,'Tigers vs Kennesaw State'),'unknown');
  assert.equal(publishedFootballMatchup(undefined,'Jacksonville State vs Kennesaw State'),'unknown');
  assert.equal(publishedFootballMatchup({league:'nfl',teams:expectedMatchup.teams},'Jacksonville State vs Kennesaw State'),'unknown');
});

async function withObserver(run:(requests:unknown[])=>Promise<void>):Promise<void>{
  const requests:unknown[]=[];
  const server=createServer(async(request,response)=>{
    if(request.url!=='/observe'){response.writeHead(404);response.end();return;}
    const parts:Uint8Array[]=[];
    for await(const part of request)parts.push(part);
    requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')));
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({url:'https://cdn.example/live/index.m3u8',referer:player,
      userAgent:'Observed Chromium/1.0',capability:'11111111-1111-4111-8111-111111111111'}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const priorOrigin=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const priorToken=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='test-control-token';
  try{await run(requests);}finally{
    if(priorOrigin===undefined)delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
    else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=priorOrigin;
    if(priorToken===undefined)delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
    else process.env.SUNDAY_ROOM_CONTROL_TOKEN=priorToken;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}

function requester(page:string,nested:string,final=parent){
  return async(url:URL):Promise<Response>=>{
    if(url.href===source)return new Response(null,{status:301,headers:{Location:final}});
    if(url.href===parent)return new Response(page,{headers:{'Content-Type':'text/html'}});
    if(url.href===player||url.href===wrongPlayer)return new Response(nested,{headers:{'Content-Type':'text/html'}});
    throw new Error('Unexpected provider request');
  };
}

test('one positively identified Dudestream CFB server opens inside its exact published parent',async()=>{
  await withObserver(async requests=>{
    const playback=await sportsurgeV2Provider(requester(
      parentHtml('Jacksonville State vs Kennesaw State – Dudestream',[player]),
      playerHtml('Jacksonville State vs Kennesaw State'))).open(locator,new AbortController().signal,'probe');
    assert.equal(playback.root.identity,'https://cdn.example/live/index.m3u8');
    assert.deepEqual(requests,[{url:player,purpose:'probe',embeddedEventUrl:parent}]);
    playback.close();
  });
});

test('Dudestream contradictions end before browser fallback',async()=>{
  await withObserver(async requests=>{
    for(const [page,nested] of [
      [parentHtml('Troy Trojans vs Kennesaw State Owls',[player]),playerHtml('Jacksonville State vs Kennesaw State')],
      [parentHtml('Jacksonville State vs Kennesaw State',[wrongPlayer]),playerHtml('Jacksonville State vs Kennesaw State')],
      [parentHtml('Jacksonville State vs Kennesaw State',[player]),playerHtml('Troy Trojans vs Kennesaw State Owls')],
    ])await assert.rejects(sportsurgeV2Provider(requester(page,nested)).open(locator,new AbortController().signal),
      /conflicting.*matchup/i);
    assert.equal(requests.length,0);
  });
});

test('unknown or incomplete Dudestream identity cannot enter embedded activation',async()=>{
  await withObserver(async requests=>{
    for(const [page,nested,metadata] of [
      [parentHtml('Tigers vs Kennesaw State',[player]),playerHtml('Jacksonville State vs Kennesaw State'),true],
      [parentHtml('Jacksonville State vs Kennesaw State',[player,player]),playerHtml('Jacksonville State vs Kennesaw State'),true],
      [parentHtml('Jacksonville State vs Kennesaw State',[player],'https://dudestream1.com/other/'),playerHtml('Jacksonville State vs Kennesaw State'),true],
      [parentHtml('Jacksonville State vs Kennesaw State',[player]),playerHtml('Live Football Player'),true],
      [parentHtml('Jacksonville State vs Kennesaw State',[player]),playerHtml('Jacksonville State vs Kennesaw State'),false],
    ] as const){
      const input=metadata?locator:{...locator,expectedMatchup:undefined};
      const playback=await sportsurgeV2Provider(requester(page,nested)).open(input,new AbortController().signal);
      playback.close();
      assert.deepEqual(requests.at(-1),{url:source,purpose:'playback'});
    }
  });
});
