import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import {SportsurgeCatalogSchema,type Game,type SportsurgeCatalog} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-03T20:00:00Z');
const team=(name:string,id:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const live:Game={id:'ncaaf-999',league:'ncaaf',name:'Delaware at Virginia',date:new Date(at).toISOString(),
  home:team('Virginia Cavaliers','espn:ncaaf:258'),away:team('Delaware Blue Hens','espn:ncaaf:48'),
  status:'in',lifecycle:'live',detail:'Q2',redzone:false,partitions:['fcs']};
const event=(number:string):SportsurgeCatalog['events'][number]=>({
  id:`ncaaf:${number}`,url:`https://v2.sportsurge.net/watch-${number}-cfb-delaware-blue-hens-vs-virginia-cavaliers/`,
  league:'ncaaf',title:'Delaware Blue Hens vs Virginia Cavaliers',teams:['Delaware Blue Hens','Virginia Cavaliers'],
  kickoff:null,sourceStatus:'live',advertisedLinkCount:1,
  detail:{kind:'collected',at,providers:[{id:'provider-1',label:'Public route',observedAt:at,
    destination:{kind:'link',url:'https://public.example/watch/1'}}]},
});
const catalog=(runId:string,startedAt:number,events:SportsurgeCatalog['events']):SportsurgeCatalog=>SportsurgeCatalogSchema.parse({
  runId,sequence:0,startedAt,state:{kind:'collecting'},
  categories:{ncaaf:{kind:'collected',at:startedAt},nfl:{kind:'pending'}},events,rejectedGames:[],catalogIssues:[],
});

async function until(check:()=>Promise<boolean>):Promise<void>{
  for(let i=0;i<200;i++){if(await check())return;await new Promise<void>(resolve=>setImmediate(resolve));}
  assert.fail('expected verified candidate did not appear');
}

test('a bound final event and an unmatched lookalike remain out of the feed window',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'final-bound-event-'));
  const path=join(dir,'state.sqlite');
  const store=new FootballStore(path);
  let clock=at+30_000;
  let probes=0;
  let scheduled:Game=live;
  store.savePartition('fcs',{games:[live],at:clock});
  const coordinator=new FootballCoordinator({store,schedules:[{id:'fcs',league:'ncaaf',path:'',group:null}],
    sources:[{id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge-v2',kind:'browser-catalog'}],
    readSchedule:async()=>({games:[scheduled],at:clock,league:'ncaaf'}),
    readSeasonMembership:async()=>{throw new Error('unused');},readHtml:async()=>{throw new Error('unused');},
    parseListings:()=>({observations:[],outcome:'empty'}),enrichObservation:value=>value,compatiblePlayers:()=>[],
    retryAfterMs:()=>0,probeCandidate:async()=>{probes++;return {kind:'playable',proof:'media'};},now:()=>clock,
    id:()=> '11111111-1111-4111-8111-111111111111'});
  const original=event('65345');
  try{
    await coordinator.command({kind:'set-retention',minutes:5});
    const first=catalog('11111111-1111-4111-8111-111111111111',at,[original]);
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog:first}),
      {kind:'catalog-ack',skipDetailEventIds:[]});
    assert.deepEqual(store.sourceEventBindings().map(row=>[row.eventId,row.gameId]),[[original.id,live.id]]);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.find(row=>row.gameId===live.id)?.workingChoiceCount===1;
    });
    const opened=await coordinator.command({kind:'open',gameId:live.id,manual:false});
    assert.equal(opened.kind,'playback');
    if(opened.kind!=='playback')return;
    const session=opened.playback.session;
    clock=at+60_000;
    scheduled={...live,status:'post',lifecycle:'final',detail:'Final',finalObservedAt:clock,graceEndsAt:clock+5*60_000};
    await coordinator.refresh(true);
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog:first}),
      {kind:'catalog-ack',skipDetailEventIds:[original.id]});
    const lookalike=event('65346');
    const second=catalog('22222222-2222-4222-8222-222222222222',clock,[original,lookalike]);
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog:second}),
      {kind:'catalog-ack',skipDetailEventIds:[original.id,lookalike.id]});
    const sources=await coordinator.command({kind:'sources'});
    assert.equal(sources.kind,'sources');
    if(sources.kind==='sources'){
      assert.deepEqual(sources.snapshot.sportsurgeV2.current?.games.map(row=>row.id),[]);
      assert.equal(sources.snapshot.sources[0].links.some(row=>row.url===original.url),false);
      assert.equal(sources.snapshot.games.find(row=>row.gameId===live.id)?.workingChoiceCount,1);
      assert.equal(sources.snapshot.games.find(row=>row.gameId===live.id)?.candidates.length,1);
    }
    assert.equal(probes,1);
    const during=await coordinator.command({kind:'authorize',sessionId:session.id,candidateId:session.candidateId,generation:session.generation});
    assert.equal(during.kind,'authorized');
    clock+=5*60_000+1;
    await coordinator.command({kind:'sources'});
    assert.equal(store.observations().some(row=>row.url===original.url),false);
    assert.equal(store.observations().some(row=>row.url===lookalike.url),false);
    assert.equal((await coordinator.command({kind:'authorize',sessionId:session.id,candidateId:session.candidateId,generation:session.generation})).kind,'error');
    const reused={...original,kickoff:at+7*24*3600_000,sourceStatus:'upcoming' as const};
    const third=catalog('33333333-3333-4333-8333-333333333333',clock,[reused,lookalike]);
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog:third}),
      {kind:'catalog-ack',skipDetailEventIds:[original.id,lookalike.id]},
      'a conflicting future date cannot reuse the old binding or enter the feed window');
    const futureSources=await coordinator.command({kind:'sources'});
    assert.equal(futureSources.kind,'sources');
    if(futureSources.kind==='sources'){
      assert.deepEqual(futureSources.snapshot.sportsurgeV2.current?.games.map(row=>row.id),[]);
      assert.equal(futureSources.snapshot.sources[0].links.some(row=>row.url===original.url),false);
      assert.equal(futureSources.snapshot.games.some(row=>row.candidates.some(candidate=>candidate.sourceIds.includes('sportsurge-v2'))),false);
    }
    assert.equal(probes,1);
    assert.equal(store.observations().some(row=>row.url===original.url&&row.kickoff===reused.kickoff),false);
    await coordinator.stop();
    const reopened=new FootballStore(path);
    try{assert.deepEqual(reopened.sourceEventBindings().map(row=>[row.eventId,row.gameId]),[[original.id,live.id]]);}
    finally{reopened.close();}
  }finally{await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});
