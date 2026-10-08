import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sanitizeStreameastCatalog, streameastCandidates, streameastCatalogView, streameastDecision } from '../lib/football/domain/streameast-catalog.ts';
import { StreameastCatalogSchema } from '../lib/football/shared.ts';
import type { StreameastCatalog } from '../lib/football/shared.ts';

const require=createRequire(import.meta.url);
const {parseDetail,freeServerUrls,activeFreeServerUrl}=require('../desktop/streameast-catalog.cjs');
const {runStreameastSweep}=require('../desktop/streameast-sweep.cjs');
const at=Date.parse('2026-10-03T03:10:00Z');
const eventUrl='https://v2.streameast.ga/cfb/montana-state-bobcats-vs-idaho-vandals-1790994600/';
const event={id:'ncaaf:12345',url:eventUrl,league:'ncaaf' as const,title:'Montana State Bobcats vs Idaho Vandals',
  teams:['Montana State Bobcats','Idaho Vandals'] as [string,string],kickoff:at,espnEventId:null,detail:{kind:'pending' as const}};
const freeOne=`${eventUrl}1`;
const freeTwo=`${eventUrl}2`;
const premium=`${eventUrl}3`;
const unknown=`${eventUrl}4`;
const detailHtml=`<div class="stream-alt-list">
  <a class="stream-alt-item" href="${freeOne}"><span class="stream-alt-name">Free 1</span><span class="stream-alt-free-badge">Free</span></a>
  <a class="stream-alt-item" href="${freeTwo}"><span class="stream-alt-name">Free 2</span><span class="stream-alt-free-badge">Free</span></a>
  <a class="stream-alt-item stream-alt-item-pro" href="${premium}"><span class="stream-alt-name">Pro</span><span class="stream-alt-free-badge">Free</span></a>
  <a class="stream-alt-item" href="${unknown}"><span class="stream-alt-name">Unknown</span></a>
</div>`;

test('the sweep visits and retains every free server and skips paid and unclassified rows',async()=>{
  const category=`<article class="m-card" data-match-id="12345" data-team-names="Montana State Bobcats|Idaho Vandals" data-time="1790994600">
    <a class="m-card__link" aria-label="Montana State Bobcats vs Idaho Vandals" href="${eventUrl}"></a></article>`;
  const empty='<div id="m-schedule-empty" class="m-empty"><h2 class="m-empty__title">No NFL games available</h2></div>';
  const visited:string[]=[];
  const result:StreameastCatalog=await runStreameastSweep({
    read:async(url:string,page:string,league:string)=>{
      visited.push(url);
      if(page==='category')return url.includes('/cfb-streams/')?category:empty.replace('NFL games',league==='f1'?'F1 races':`${league.toUpperCase()} games`);
      if(page==='detail')return detailHtml;
      if(url===freeOne)return '<iframe src="https://streame.center/stream-east/ch33.php"></iframe>';
      if(url===freeTwo)return '<iframe src="https://streame.center/stream-east/ch34.php"></iframe>';
      throw new Error('Paid or unknown server visited');
    },
    send:async()=>{},signal:new AbortController().signal,now:()=>at,
    runId:'11111111-1111-4111-8111-111111111111',
  });
  assert.equal(result.state.kind,'complete');
  assert.deepEqual(visited.filter(url=>url===freeOne||url===freeTwo),[freeOne,freeTwo]);
  assert.equal(visited.includes(premium),false);
  assert.equal(visited.includes(unknown),false);
  assert.equal(result.events[0].detail.kind,'collected');
  if(result.events[0].detail.kind!=='collected')return;
  assert.deepEqual(result.events[0].detail.servers.map(server=>server.availability.kind),['free-channel','free-channel']);
  assert.deepEqual(streameastCandidates(result.events[0],'ncaaf-401868094').map(candidate=>candidate.id),['streameast:33','streameast:34']);
  assert.equal(StreameastCatalogSchema.safeParse(result).success,true);
});

test('a missing server list fails while a recognized paid-only list is collected empty',()=>{
  assert.equal(parseDetail('<div></div>',event,at,new Map()).reason,'parser-changed');
  const paidOnly=`<div class="stream-alt-list"><a class="stream-alt-item stream-alt-item-pro" href="${premium}"><span class="stream-alt-pro-icon"></span></a></div>`;
  assert.deepEqual(parseDetail(paidOnly,event,at,new Map()),{kind:'collected',at,servers:[],publication:{premium:1,unknown:0}});
  assert.deepEqual(freeServerUrls(paidOnly,event),[]);
  assert.equal(activeFreeServerUrl(paidOnly,event),null);
});

test('the current paid-only event template yields zero free servers for the exact listed game',()=>{
  const paidOnly=`<main class="streameast-video-page">
    <ul id="se-streams-list" class="se-streams__list">
      <li class="se-stream is-pro is-active"><a class="se-stream__link" href="${premium}">NCAAF Local</a></li>
      <li class="se-stream se-stream--share"><button>Share</button></li>
    </ul><div class="se-progate"><p class="se-progate__match">${event.title}</p></div></main>`;
  assert.deepEqual(parseDetail(paidOnly,event,at,new Map()),{kind:'collected',at,servers:[],publication:{premium:1,unknown:0}});
  assert.deepEqual(freeServerUrls(paidOnly,event),[]);
  assert.equal(parseDetail(paidOnly,{...event,title:'Other game'},at,new Map()).reason,'parser-changed');
  assert.equal(parseDetail(paidOnly.replace('is-pro',''),event,at,new Map()).reason,'parser-changed');
  assert.equal(parseDetail(paidOnly.replace(premium,'https://v2.streameast.ga/cfb/other-game/1'),event,at,new Map()).reason,'parser-changed');
});

test('a same-event upcoming placeholder has no published free server yet',()=>{
  const upcoming=`<main class="streameast-video-page">
    <div class="se-board" data-match-id="12345"></div>
    <h2 class="se-countdown__title">Stream starting soon</h2>
    <nav class="se-streams se-streams--share-only"><ul class="se-streams__list">
      <li class="se-stream se-stream--share"><button>Share</button></li>
    </ul></nav></main>`;
  assert.deepEqual(parseDetail(upcoming,event,at,new Map()),{kind:'collected',at,servers:[],publication:{premium:0,unknown:0}});
  assert.equal(parseDetail(upcoming.replace('12345','99999'),event,at,new Map()).reason,'parser-changed');
  assert.equal(parseDetail(upcoming.replace('Stream starting soon','Watch now'),event,at,new Map()).reason,'parser-changed');
  assert.equal(parseDetail(upcoming.replace('se-stream--share','is-pro').replace('<button>Share</button>',`<a class="se-stream__link" href="${premium}">Premium</a>`),event,at,new Map()).reason,'parser-changed');
});

test('historical mixed catalogs expose only free rows and accept identical free-only retries',()=>{
  const raw:StreameastCatalog={runId:'22222222-2222-4222-8222-222222222222',sequence:0,startedAt:at,
    state:{kind:'complete',at},categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},rejectedGames:[],
    events:[{...event,detail:{kind:'collected',at,servers:[
      {id:'1',label:'Free 1',url:freeOne,availability:{kind:'free-channel',channelId:'33'}},
      {id:'2',label:'Free 2',url:freeTwo,availability:{kind:'free-unresolved'}},
      {id:'3',label:'Pro',url:premium,availability:{kind:'premium'}},
      {id:'4',label:'Unknown',url:unknown,availability:{kind:'unknown'}},
    ]}}]};
  const sanitized=sanitizeStreameastCatalog(raw,at);
  assert.ok(sanitized);
  assert.equal(raw.events[0].detail.kind,'collected');
  if(raw.events[0].detail.kind!=='collected'||sanitized.events[0].detail.kind!=='collected')return;
  assert.equal(raw.events[0].detail.servers.length,4);
  assert.deepEqual(sanitized.events[0].detail.servers.map(server=>server.id),['1','2']);
  const view=streameastCatalogView({catalog:raw,receivedAt:at},[],at);
  assert.equal(view.serverRows,4);
  assert.equal(view.freeRows,2);
  assert.equal(view.premiumRows,1);
  assert.equal(view.unknownRows,2);
  assert.deepEqual(sanitized.events[0].detail.publication,{premium:1,unknown:1});
  assert.deepEqual(view.games[0].detail.kind==='collected'?view.games[0].detail.servers.map(server=>server.id):[],['1','2']);
  const previous={catalog:raw,receivedAt:at};
  assert.equal(streameastDecision(previous,sanitized),'replay');
  const changed=structuredClone(sanitized);
  if(changed.events[0].detail.kind!=='collected')return;
  changed.events[0].detail.servers[0].availability={kind:'free-channel',channelId:'35'};
  assert.equal(streameastDecision(previous,changed),'rejected');
});
