import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { catalogDecision, sanitizeSportsurgeCatalog, sportsurgeCatalogView, sportsurgeObservation } from '../lib/football/domain/sportsurge-catalog.ts';
import { SportsurgeCatalogSchema } from '../lib/football/shared.ts';
import type { Game, SportsurgeCatalog } from '../lib/football/shared.ts';

const require=createRequire(import.meta.url);
const {CATEGORY_URLS,parseCategory,parseDetail,destination}=require('../desktop/sportsurge-catalog.cjs');
const {runSportsurgeSweep}=require('../desktop/sportsurge-sweep.cjs');
const fixture=(name:string)=>readFileSync(join(process.cwd(),'tests','fixtures','sportsurge',`${name}.html`),'utf8');
const at=Date.parse('2026-09-26T21:00:00Z');
const runId='11111111-1111-4111-8111-111111111111';

test('captured Sportsurge pages preserve all category games and provider rows',()=>{
  const college=parseCategory(fixture('cfb'),'ncaaf');
  const nfl=parseCategory(fixture('nfl'),'nfl');
  assert.equal(college.kind,'collected');
  assert.equal(college.events.length,47);
  assert.equal(college.events[0].id,'ncaaf:65345');
  assert.equal(college.events[0].sourceStatus,'live');
  assert.equal(college.events[0].kickoff,null);
  assert.equal(college.events[0].advertisedLinkCount,17);
  assert.equal(nfl.kind,'collected');
  assert.equal(nfl.events.length,0);
  const detail=parseDetail(fixture('detail'),college.events[0],at);
  assert.equal(detail.kind,'collected');
  assert.equal(detail.providers.length,17);
  assert.equal(detail.providers[0].label,'Streameast');
  assert.equal(detail.providers[0].id,'stream-1303403-0');
  assert.equal(detail.providers[0].destination.kind,'link');
  assert.equal(parseCategory('<title>Just a moment...</title>','ncaaf').reason,'blocked');
  assert.equal(parseCategory('<main id="match-list-container"><p class="match-filter-empty">No matches found</p></main>','nfl').kind,'failed');
});

test('malformed and repeated provider DOM rows remain separate while unsafe links stay private',()=>{
  const event=parseCategory(fixture('cfb'),'ncaaf').events[0];
  const html=`<div class="stream-list">
    <div class="stream-item" data-href="https://example.com/one"><span class="stream-row-site-name">Same</span><button class="stream-vote" id="stream-11"></button></div>
    <div class="stream-item" data-href="https://example.com/two"><span class="stream-row-site-name">Same</span><button class="stream-vote" id="stream-11"></button></div>
    <div class="stream-item"><span class="stream-row-site-name">Missing</span></div>
    <div class="stream-item" data-href="https://[::1]/private"><span class="stream-row-site-name">Local</span></div>
    <div class="stream-item" data-href="https://example.com/watch?token=private"><span class="stream-row-site-name">Signed</span></div>
  </div>`;
  const detail=parseDetail(html,event,at);
  assert.equal(detail.providers.length,5);
  assert.equal(new Set(detail.providers.map((row:{id:string})=>row.id)).size,5);
  assert.deepEqual(detail.providers.map((row:{destination:{kind:string}})=>row.destination.kind),['link','link','malformed','rejected','rejected']);
  assert.equal(detail.providers[2].destination.reason,'missing');
  assert.equal(detail.providers[3].destination.reason,'private-host');
  assert.equal(detail.providers[4].destination.reason,'credential-query');
  assert.equal(JSON.stringify(detail).includes('token=private'),false);
  assert.equal(destination('https://127.0.0.1/watch').reason,'private-host');
  assert.equal(destination('https://[::1]/watch').reason,'private-host');
});

test('every distinct detail is visited beyond the generic 80-slot budget and a late failure stays partial',async()=>{
  const category=`<main id="match-list-container">${Array.from({length:85},(_,index)=>
    `<a class="match-row" href="watch-${10000+index}-cfb-away-home-${index}/"><span class="match-row-team-name">Away ${index}</span><span class="match-row-team-name">Home ${index}</span><time class="match-time" data-timestamp="1790461800"></time>1 Stream</a>`).join('')}</main>`;
  const empty='<main id="match-list-container"><div class="watch-empty-state">There are no live or upcoming games here right now.</div></main>';
  const detail='<div class="stream-list"><div class="stream-item" data-href="https://example.com/watch"><span class="stream-row-site-name">Example</span></div></div>';
  const reads:string[]=[];
  const checkpoints:SportsurgeCatalog[]=[];
  const read=async(url:string,page:string)=>{
    reads.push(url);
    if (page==='category') return url===CATEGORY_URLS.ncaaf ? category : empty;
    if (url.includes('watch-10084-')) throw new Error('timeout');
    return detail;
  };
  const send=async(value:SportsurgeCatalog)=>{checkpoints.push(structuredClone(value));};
  const result=await runSportsurgeSweep({read,send,signal:new AbortController().signal,now:()=>at,runId});
  assert.equal(reads.filter(url=>url.includes('/watch-1') && url.includes('-cfb-')).length,85);
  assert.equal(result.events.length,85);
  assert.equal(result.events.filter((event:SportsurgeCatalog['events'][number])=>event.detail.kind==='collected').length,84);
  assert.equal(result.events[84].detail.kind,'failed');
  assert.equal(result.state.kind,'partial');
  assert.equal(checkpoints.at(-1)?.events.length,85);
  assert.equal(checkpoints.length,89);
  const verified=SportsurgeCatalogSchema.safeParse(checkpoints.at(-1));
  assert.equal(verified.success,true);
});

test('distinct canonical URLs with one numeric ID are both retained and diagnosed',()=>{
  const html=`<main id="match-list-container">
    <a class="match-row" href="watch-123-cfb-away-home/"><span class="match-row-team-name">Away</span><span class="match-row-team-name">Home</span></a>
    <a class="match-row" href="watch-123-cfb-away-home-alt/"><span class="match-row-team-name">Away</span><span class="match-row-team-name">Home</span></a>
    <a class="match-row" href="https://bad.example/watch-999-cfb-other/"><span class="match-row-team-name">Bad</span><span class="match-row-team-name">Other</span></a>
  </main>`;
  const result=parseCategory(html,'ncaaf');
  assert.equal(result.kind,'failed');
  assert.equal(result.events.length,2);
  assert.equal(result.catalogIssues.length,1);
  assert.equal(result.rejectedGames.length,1);
});

test('checkpoint replay, prior partial retention, removed links, and ESPN final isolation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'sportsurge-catalog-'));
  const store=new FootballStore(join(dir,'state.sqlite'));
  try {
    const event=parseCategory(fixture('cfb'),'ncaaf').events[0];
    event.detail=parseDetail(fixture('detail'),event,at);
    const partial:SportsurgeCatalog={runId,sequence:0,startedAt:at,state:{kind:'partial',at,reason:'timeout'},
      categories:{ncaaf:{kind:'collected',at},nfl:{kind:'failed',at,reason:'timeout'}},events:[event],rejectedGames:[],catalogIssues:[]};
    assert.ok(sanitizeSportsurgeCatalog(partial));
    assert.equal(catalogDecision(null,partial),'accepted');
    const observation=sportsurgeObservation(event,at);
    const unrelated={...observation,id:'tvapp:unrelated',sourceId:'tvapp',url:'https://tvapp1.com/watch/unrelated'};
    const unmatched={kind:'unmatched' as const,reason:'unverified-kickoff',possibleGameIds:[]};
    store.saveSportsurgeCatalog({catalog:partial,receivedAt:at},[{observation,result:unmatched},{observation:unrelated,result:unmatched}]);
    assert.equal(store.observations().length,2);
    assert.equal(catalogDecision(store.sportsurgeCatalog().current,partial),'replay');
    const replacement:SportsurgeCatalog={runId:'22222222-2222-4222-8222-222222222222',sequence:0,startedAt:at+1,
      state:{kind:'collecting'},categories:{ncaaf:{kind:'pending'},nfl:{kind:'pending'}},events:[],rejectedGames:[],catalogIssues:[]};
    assert.equal(catalogDecision(store.sportsurgeCatalog().current,replacement),'accepted');
    store.saveSportsurgeCatalog({catalog:replacement,receivedAt:at+1},[]);
    assert.equal(store.sportsurgeCatalog().previous?.catalog.events.length,1);
    assert.deepEqual(store.observations().map(row=>row.id),['tvapp:unrelated']);
    assert.equal(catalogDecision(store.sportsurgeCatalog().current,partial),'rejected');
    const completed:SportsurgeCatalog={...replacement,sequence:1,state:{kind:'complete',at:at+2},
      categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},events:[event]};
    store.saveSportsurgeCatalog({catalog:completed,receivedAt:at+2},[{observation,result:unmatched}]);
    assert.equal(store.sportsurgeCatalog().lastComplete?.catalog.events.length,1);
    const nextPartial:SportsurgeCatalog={...replacement,runId:'33333333-3333-4333-8333-333333333333',startedAt:at+3,
      sequence:0,state:{kind:'partial',at:at+3,reason:'timeout'},events:[]};
    store.saveSportsurgeCatalog({catalog:nextPartial,receivedAt:at+3},[]);
    assert.equal(store.sportsurgeCatalog().lastComplete?.catalog.runId,completed.runId);
    const team=(name:string,id:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
    const final:Game={id:'ncaaf-999',league:'ncaaf',name:'Delaware at Virginia',date:new Date(at).toISOString(),
      home:team('Virginia Cavaliers','espn:ncaaf:258'),away:team('Delaware Blue Hens','espn:ncaaf:48'),
      status:'post',lifecycle:'final',detail:'Final',redzone:false,finalObservedAt:at,graceEndsAt:at+300000};
    const view=sportsurgeCatalogView({catalog:partial,receivedAt:at},[final],at);
    assert.equal(view.games[0].gameId,null);
    assert.equal(view.providerRows,17);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
