import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {compatiblePlayers,enrichObservation,parseListings,SOURCES} from '../lib/football/adapters/sources.ts';
import {provisionalLiveChannel,resolvedLiveChannelMatch} from '../lib/football/domain/live-channel.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import {detailIdentity} from '../lib/football/domain/source-policy.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {GameSchema,type DetailEvidence,type Game,type Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T00:33:22Z');
const fixture=(name:string,extension='html')=>readFileSync(new URL(`./fixtures/buffstream-future-${name}.${extension}`,import.meta.url),'utf8');
const games=GameSchema.array().parse(JSON.parse(fixture('games','json')));
const sources=SOURCES.filter(source=>source.id==='buffstream-nfl'||source.id==='buffstream-cfb');
const observations=sources.flatMap(source=>parseListings(source,fixture(source.id==='buffstream-nfl'?'nfl-catalog':'cfb-catalog'),at).observations);
const html=(observation:Observation)=>fixture(new URL(observation.url).pathname.split('/').at(-1)!.replace('-live-stream',''));
const evidence=(observation:Observation,game:Game):Extract<DetailEvidence,{outcome:'resolved'}>=>({outcome:'resolved',observationId:observation.id,
  identity:detailIdentity(observation),generation:'fixture',at,nextEligibleAt:at+300_000,
  players:compatiblePlayers(game.id,observation,html(observation))});

test('captured tomorrow Buff pages bind all ten published players to five correct ESPN games',()=>{
  assert.equal(observations.length,10);
  const counts=new Map<string,number>();
  for(const observation of observations){
    const raw=matchObservation(observation,games,at);
    assert.equal(raw.kind,'unmatched');
    if(raw.kind!=='unmatched')continue;
    assert.equal(raw.possibleGameIds.length,1);
    const game=games.find(game=>game.id===raw.possibleGameIds[0]);
    assert.ok(game);
    assert.equal(provisionalLiveChannel(observation,raw,games,at)?.id,game.id);
    assert.deepEqual(enrichObservation(observation,html(observation)),observation);
    assert.equal(observation.kickoff,null);
    assert.deepEqual(resolvedLiveChannelMatch(observation,raw,games,undefined,at),raw);
    const detail=evidence(observation,game);
    assert.equal(detail.players.length,1);
    assert.deepEqual(resolvedLiveChannelMatch(observation,raw,games,detail,at),{kind:'matched',gameId:game.id});
    counts.set(game.id,(counts.get(game.id)||0)+detail.players.length);
  }
  assert.deepEqual([...counts].sort(),games.map(game=>[game.id,2]).sort());
});

test('Buff future contextual proof retains full-horizon ambiguity and requires a unique anchor',()=>{
  const observation=observations.find(row=>row.url.endsWith('/utsa-live-stream'));
  const game=games.find(game=>game.id==='ncaaf-401862794');
  assert.ok(observation&&game);
  const raw=matchObservation(observation,games,at);
  assert.deepEqual(raw,{kind:'unmatched',reason:'unverified-contextual-kickoff',possibleGameIds:[game.id]});
  const detail=evidence(observation,game);
  assert.deepEqual(resolvedLiveChannelMatch(observation,raw,games,detail,at),{kind:'matched',gameId:game.id});
  const alternate:Game={...game,id:'alternate-south-florida',date:'2026-10-10T23:30Z',
    away:{...game.away,id:'espn:ncaaf:3198',name:'SOUTH FLORIDA STARS',short:'SOUTH FLORIDA',abbreviation:'SFX'}};
  const ambiguous=matchObservation(observation,[...games,alternate],at);
  assert.deepEqual(ambiguous,{kind:'unmatched',reason:'unverified-contextual-kickoff',possibleGameIds:[game.id,alternate.id]});
  assert.equal(provisionalLiveChannel(observation,ambiguous,[game],at),null);
  assert.deepEqual(resolvedLiveChannelMatch(observation,ambiguous,[game],detail,at),ambiguous);
  const noAnchor:Observation={...observation,teams:['South Florida','SDSU']};
  const twoContextual:Game={...game,home:{...game.home,id:'espn:ncaaf:21',name:'San Diego State Aztecs',short:'San Diego St',abbreviation:'SDSU'}};
  const noAnchorResult=matchObservation(noAnchor,[twoContextual],at);
  assert.deepEqual(noAnchorResult,{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  assert.equal(provisionalLiveChannel(noAnchor,noAnchorResult,[twoContextual],at),null);
});

test('Buff scheduled proof preserves the calendar window, final exclusion, clocks and detail identity',()=>{
  for(const observation of [observations.find(row=>row.url.endsWith('/liberty-live-stream')),observations.find(row=>row.url.endsWith('/dallas-cowboys-live-stream'))]){
    assert.ok(observation);
    const raw=matchObservation(observation,games,at);
    assert.equal(raw.kind,'unmatched');
    if(raw.kind!=='unmatched')continue;
    const game=games.find(game=>game.id===raw.possibleGameIds[0]);
    assert.ok(game&&game.date);
    const detail=evidence(observation,game);
    const today={...game,date:new Date(Date.parse(game.date)-86400000).toISOString()};
    assert.equal(provisionalLiveChannel(observation,matchObservation(observation,[today],at),[today],at)?.id,game.id);
    const later={...game,date:new Date(Date.parse(game.date)+86400000).toISOString()};
    const final:Game={...game,lifecycle:'final',status:'post',finalObservedAt:at,graceEndsAt:at+300_000};
    for(const changed of [later,final])assert.equal(provisionalLiveChannel(observation,matchObservation(observation,[changed],at),[changed],at),null);
    assert.equal(provisionalLiveChannel(observation,raw,[],at),null);
    const duplicate={...game,id:'same-teams-later',date:'2026-10-12T23:00Z'};
    assert.equal(provisionalLiveChannel(observation,matchObservation(observation,[game,duplicate],at),[game],at),null);
    const badClock={...observation,rawTime:observation.league==='nfl'?'08:16 pm ET':'08:01 pm ET'};
    assert.equal(provisionalLiveChannel(badClock,raw,games,at),null);
    for(const changed of [{...observation,observedAt:at-1800000},{...observation,observedAt:at+60001},
      {...observation,sourceId:'sportsurge'},{...observation,title:'reused channel'}])
      assert.equal(resolvedLiveChannelMatch(changed,matchObservation(changed,games,at),games,detail,at).kind,'unmatched');
    for(const changed of [{...detail,at:at-1800000},{...detail,at:at+60001},{...detail,players:[]},
      {...detail,observationId:'other-observation'}])assert.deepEqual(resolvedLiveChannelMatch(observation,raw,games,changed,at),raw);
    assert.equal(compatiblePlayers(game.id,observation,html(observation).replace('rel="canonical"','rel="other"')).length,0);
    assert.equal(compatiblePlayers(game.id,observation,html(observation).replace(/american-football\/[^"]+/, 'american-football/other-vs-opponent-stream-1')).length,0);
  }
});

test('discovery collects all tomorrow Buff links while blocked media stays unavailable',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'buff-future-'));
  let clock=at;
  let schedule=games;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,sources,
    readSchedule:async partition=>({games:partition.id==='fbs'?schedule.filter(game=>game.league==='ncaaf'):
      partition.id==='nfl'?schedule.filter(game=>game.league==='nfl'):[],league:partition.league,at:clock}),
    readHtml:async url=>{
      const source=sources.find(source=>source.url===url);
      if(source)return fixture(source.id==='buffstream-nfl'?'nfl-catalog':'cfb-catalog');
      const observation=observations.find(observation=>observation.url===url);
      assert.ok(observation);
      return html(observation);
    },
    probeCandidate:async()=>({kind:'unavailable',reason:'upstream'}),
  });
  try{
    await coordinator.refresh();
    let snapshot=await coordinator.command({kind:'sources'});
    for(let i=0;i<150&&snapshot.kind==='sources'&&
      (snapshot.snapshot.games.filter(row=>games.some(game=>game.id===row.gameId)).length!==5||
      snapshot.snapshot.games.filter(row=>games.some(game=>game.id===row.gameId)).some(row=>row.candidates.length!==2||
        row.candidates.some(candidate=>candidate.availability.kind!=='unavailable')));i++){
      await new Promise<void>(resolve=>setImmediate(resolve));
      snapshot=await coordinator.command({kind:'sources'});
    }
    assert.equal(snapshot.kind,'sources');
    if(snapshot.kind==='sources'){
      assert.equal(snapshot.snapshot.sources.find(source=>source.id==='buffstream-cfb')?.matchedGameCount,4);
      assert.equal(snapshot.snapshot.sources.find(source=>source.id==='buffstream-nfl')?.matchedGameCount,1);
      for(const game of games){
        const row=snapshot.snapshot.games.find(row=>row.gameId===game.id);
        assert.ok(row);
        assert.equal(row.candidates.length,2);
        assert.equal(row.workingChoiceCount,0);
        assert.ok(row.candidates.every(candidate=>candidate.gameId===game.id&&candidate.availability.kind==='unavailable'));
        assert.equal(row.sourceLinks.filter(link=>link.evidence.kind==='collected').length,2);
      }
    }
    clock+=90001;
    const stale=await coordinator.command({kind:'sources'});
    assert.equal(stale.kind,'sources');
    if(stale.kind==='sources')assert.ok(stale.snapshot.sources.every(source=>source.matchedGameCount===0));
    schedule=games.map(game=>({...game,lifecycle:'final',status:'post',finalObservedAt:clock,graceEndsAt:clock+300_000}));
    await coordinator.refresh();
    const finished=await coordinator.command({kind:'sources'});
    assert.equal(finished.kind,'sources');
    if(finished.kind==='sources')assert.ok(finished.snapshot.sources.every(source=>source.matchedGameCount===0));
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
