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
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';
import type {DetailEvidence,Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T00:15:00Z');
const source=SOURCES.find(item=>item.id==='buffstream-cfb')!;
const fixture=(name:string)=>readFileSync(new URL(`./fixtures/buffstream-cfb-live-${name}.html`,import.meta.url),'utf8');
const team=(id:string,name:string,short:string,abbreviation:string)=>({id,name,short,abbreviation,color:'112233',score:'0'});
const games:Game[]=[
  {id:'ncaaf-401871051',league:'ncaaf',name:'Jacksonville State at Kennesaw State',date:'2026-10-07T23:00:00Z',
    home:team('espn:ncaaf:338','Kennesaw State Owls','Kennesaw St','KENN'),
    away:team('espn:ncaaf:55','Jacksonville State Gamecocks','Jax State','JXST'),
    status:'in',lifecycle:'live',detail:'Q2',redzone:false,partitions:['fbs']},
  {id:'ncaaf-401871066',league:'ncaaf',name:'NM State at FIU',date:'2026-10-08T00:04:00Z',
    home:team('espn:ncaaf:2229','Florida International Panthers','FIU','FIU'),
    away:team('espn:ncaaf:166','New Mexico State Aggies','New Mexico St','NMSU'),
    status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['fbs']},
];
const detail=(url:string)=>fixture(new URL(url).pathname.split('/').at(-1)!.replace('-live-stream',''));
const raw=(observation:Observation)=>matchObservation(observation,games,at);

test('captured CFB rows and exact published player pages bind four channels to two distinct live games',()=>{
  const parsed=parseListings(source,fixture('catalog'),at);
  assert.equal(parsed.outcome,'parsed');
  assert.equal(parsed.observations.length,4);
  const byGame=new Map<string,Set<string>>();
  for(const observation of parsed.observations){
    const game=observation.teams?.includes('Kennesaw State')?games[0]:games[1];
    assert.equal(observation.league,'ncaaf');
    assert.equal(observation.kickoff,null);
    assert.equal(observation.rawTime,game===games[0]?'07:00 pm ET':'07:30 pm ET');
    const result=raw(observation);
    assert.deepEqual(result,{kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:[game.id]});
    assert.equal(provisionalLiveChannel(observation,result,games,at)?.id,game.id);
    const html=detail(observation.url);
    assert.deepEqual(enrichObservation(observation,html),observation);
    const players=compatiblePlayers(game.id,observation,html);
    assert.equal(players.length,1);
    assert.match(players[0].label,/^Buffstream CFB · Server 1$/);
    const locator=players[0].locator;
    assert.equal(locator.provider,'event-page');
    if(locator.provider==='event-page'){
      assert.equal(validEventPagePair(locator.eventUrl,locator.serverUrl),true);
      assert.equal(locator.gameId,game.id);
    }
    const evidence:DetailEvidence={outcome:'resolved',observationId:observation.id,identity:detailIdentity(observation),
      generation:'fixture',at,players,nextEligibleAt:at+300_000};
    assert.deepEqual(resolvedLiveChannelMatch(observation,result,games,evidence,at),{kind:'matched',gameId:game.id});
    byGame.set(game.id,(byGame.get(game.id)||new Set()).add(players[0].id));
  }
  assert.deepEqual([...byGame].map(([id,ids])=>[id,ids.size]),games.map(game=>[game.id,2]));
});

test('CFB clock allowance remains exact-team, fresh and source-scoped',()=>{
  const observation=parseListings(source,fixture('catalog'),at).observations[0];
  assert.ok(observation);
  const game=games[0];
  const result=raw(observation);
  const goodPlayers=compatiblePlayers(game.id,observation,detail(observation.url));
  const evidence:DetailEvidence={outcome:'resolved',observationId:observation.id,identity:detailIdentity(observation),
    generation:'fixture',at,players:goodPlayers,nextEligibleAt:at+300_000};
  assert.equal(provisionalLiveChannel({...observation,rawTime:'08:00 pm ET'},result,games,at)?.id,game.id);
  for(const changed of [
    {...observation,rawTime:'08:01 pm ET'},
    {...observation,observedAt:at-30*60_000},
    {...observation,observedAt:at+60_001},
    {...observation,sourceId:'buffstream-nfl'},
    {...observation,league:'nfl' as const},
    {...observation,kickoff:Date.parse('2026-10-07T23:00:00Z')},
  ]) assert.equal(provisionalLiveChannel(changed,result,games,at),null);
  for(const changed of [
    {...game,lifecycle:'scheduled' as const,status:'pre' as const,date:'2026-10-09T23:00:00Z'},
    {...game,lifecycle:'final' as const,status:'post' as const,finalObservedAt:at},
  ]) assert.equal(provisionalLiveChannel(observation,result,[changed],at),null);
  const repeated={...game,id:'ncaaf-401871999',date:'2026-10-14T23:00:00Z'};
  assert.equal(provisionalLiveChannel(observation,matchObservation(observation,[game,repeated],at),[game],at),null);
  assert.deepEqual(resolvedLiveChannelMatch(observation,result,games,{...evidence,at:at-30*60_000},at),result);
  assert.deepEqual(resolvedLiveChannelMatch(observation,result,games,{...evidence,players:[{...goodPlayers[0],locator:{
    provider:'event-page',gameId:'ncaaf-401871999',eventUrl:observation.url,serverUrl:'https://embedsports.me/american-football/jacksonville-state-vs-kennesaw-state-stream-1'}}]},at),result);
  assert.deepEqual(compatiblePlayers(game.id,observation,detail(observation.url).replace('rel="canonical"','rel="other"')),[]);
  assert.deepEqual(compatiblePlayers(game.id,observation,detail(observation.url).replace('jacksonville-state-vs-kennesaw-state','other-team-vs-kennesaw-state')),[]);
  assert.deepEqual(compatiblePlayers(game.id,{...observation,sourceId:'buffstream-nfl',league:'nfl'},detail(observation.url)),[]);
  assert.deepEqual(compatiblePlayers(game.id,{...observation,league:'nfl'},detail(observation.url)),[]);
  assert.equal(validEventPagePair(observation.url,'https://embedsports.me/american-football/jacksonville-state-vs-kennesaw-state-stream-1?paid=true'),false);
  assert.equal(parseListings(source,'<a href="http://ms.buffstream.io/nfl-streams/detroit-lions-live-stream">Detroit Lions vs Carolina Panthers2026-10-07 - 07:00 pm ET</a>',at).observations.length,0);
  const nfl=SOURCES.find(item=>item.id==='buffstream-nfl')!;
  assert.equal(parseListings(nfl,'<a href="http://ms.buffstream.io/cfb-streams/kennesaw-state-live-stream">Kennesaw State vs Jacksonville State2026-10-07 - 07:00 pm ET</a>',at).observations.length,0);
});

test('CFB discovery publishes all four verified live channels under the correct games',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'buff-cfb-live-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>at,sources:[source],
    readSchedule:async schedule=>({games:schedule.id==='fbs'?games:[],league:schedule.league,at}),
    readHtml:async url=>url===source.url?fixture('catalog'):detail(url),
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  try{
    await coordinator.refresh();
    let snapshot=await coordinator.command({kind:'sources'});
    for(let i=0;i<150&&snapshot.kind==='sources'&&
      (snapshot.snapshot.games.filter(row=>games.some(game=>game.id===row.gameId)).length!==2||
      snapshot.snapshot.games.filter(row=>games.some(game=>game.id===row.gameId))
        .some(row=>row.workingChoiceCount!==2));i++){
      await new Promise<void>(resolve=>setImmediate(resolve));
      snapshot=await coordinator.command({kind:'sources'});
    }
    assert.equal(snapshot.kind,'sources');
    if(snapshot.kind==='sources'){
      const inventory=snapshot.snapshot.sources.find(row=>row.id==='buffstream-cfb');
      assert.equal(inventory?.matchedGameCount,2);
      for(const game of games){
        const row=snapshot.snapshot.games.find(row=>row.gameId===game.id);
        assert.ok(row);
        assert.equal(row.candidates.length,2);
        assert.equal(row.workingChoiceCount,2);
        assert.ok(row.candidates.every(candidate=>candidate.gameId===game.id&&candidate.availability.kind==='playable'));
        assert.equal(row.sourceLinks.filter(link=>link.sourceId==='buffstream-cfb'&&link.evidence.kind==='collected').length,2);
      }
    }
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
