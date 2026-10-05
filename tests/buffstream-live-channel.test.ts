import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {compatiblePlayers,enrichObservation,parseListings,SOURCES} from '../lib/football/adapters/sources.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import {provisionalLiveChannel,resolvedLiveChannelMatch} from '../lib/football/domain/live-channel.ts';
import {detailIdentity} from '../lib/football/domain/source-policy.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {DetailEvidence,Game} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-05T03:00:00Z');
const fixture=(name:string)=>readFileSync(new URL(`./fixtures/buffstream-nfl-live-${name}.html`,import.meta.url),'utf8');
const source=SOURCES.find(source=>source.id==='buffstream-nfl')!;
const team=(name:string)=>({id:name,name,short:name,abbreviation:name,color:'112233',score:'0'});
const game:Game={id:'401872978',league:'nfl',name:'Detroit Lions at Carolina Panthers',date:'2026-10-05T00:20:00Z',
  away:team('Detroit Lions'),home:team('Carolina Panthers'),status:'in',lifecycle:'live',detail:'Q4',redzone:false};

test('captured Buff team channels bind one live game only after exact published player evidence',()=>{
  const observations=parseListings(source,fixture('catalog'),at).observations;
  assert.equal(observations.length,2);
  const ids=new Set<string>();
  for(const observation of observations){
    assert.equal(observation.kickoff,null);
    assert.equal(observation.rawTime,'08:20 pm ET');
    const html=fixture(observation.url.includes('detroit')?'detroit':'carolina');
    assert.deepEqual(enrichObservation(observation,html),observation);
    const raw=matchObservation(observation,[game],at);
    assert.deepEqual(raw,{kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:[game.id]});
    assert.equal(provisionalLiveChannel(observation,raw,[game],at)?.id,game.id);
    assert.deepEqual(resolvedLiveChannelMatch(observation,raw,[game],undefined,at),raw);
    const players=compatiblePlayers(game.id,observation,html);
    assert.equal(players.length,1);
    assert.equal(compatiblePlayers(game.id,observation,html.replace('rel="canonical"','rel="other"')).length,0);
    assert.equal(compatiblePlayers(game.id,observation,html.replace('carolina-panthers-vs-detroit-lions','carolina-panthers-vs-atlanta-falcons')).length,0);
    assert.match(players[0].label,/^Buffstream NFL · Server [12]$/);
    ids.add(players[0].id);
    const detail:DetailEvidence={outcome:'resolved',observationId:observation.id,identity:detailIdentity(observation),
      generation:'fixture',at,players,nextEligibleAt:at+300_000};
    assert.deepEqual(resolvedLiveChannelMatch(observation,raw,[game],detail,at),{kind:'matched',gameId:game.id});
    assert.deepEqual(resolvedLiveChannelMatch({...observation,observedAt:at+1000},raw,[game],detail,at+1000),{kind:'matched',gameId:game.id});
    for(const changed of [{...observation,rawTime:'08:21 pm ET'},{...observation,observedAt:at-1800000},
      {...observation,observedAt:at+60001},{...observation,title:'changed'}])
      assert.equal(resolvedLiveChannelMatch(changed,matchObservation(changed,[game],at),[game],detail,at).kind,'unmatched');
    for(const games of [[],[{...game,lifecycle:'scheduled' as const,status:'pre' as const}],
      [{...game,lifecycle:'final' as const,status:'post' as const,finalObservedAt:at}],
      [game,{...game,id:'ambiguous'}]])
      assert.equal(resolvedLiveChannelMatch(observation,matchObservation(observation,games,at),games,detail,at).kind,'unmatched');
    assert.deepEqual(resolvedLiveChannelMatch(observation,raw,[game],{...detail,at:at-1800000},at),raw);
    assert.deepEqual(resolvedLiveChannelMatch(observation,raw,[game],{...detail,at:at+60001},at),raw);
    const locator=players[0].locator;
    assert.equal(locator.provider,'event-page');
    if(locator.provider==='event-page'){
      assert.deepEqual(resolvedLiveChannelMatch(observation,raw,[game],{...detail,players:[{...players[0],locator:{...locator,gameId:'other'}}]},at),raw);
      assert.deepEqual(resolvedLiveChannelMatch(observation,raw,[game],{...detail,players:[{...players[0],locator:{...locator,eventUrl:observation.url+'/other'}}]},at),raw);
      for(const bad of [locator.serverUrl+'?paid=true',locator.serverUrl.replace('embedsports.me','embedsports.me.evil.test'),
        locator.serverUrl.replace('https:','http:'),locator.serverUrl.replace('carolina-panthers-vs-detroit-lions','atlanta-falcons-vs-new-orleans-saints')]){
        assert.equal(validEventPagePair(observation.url,bad),false);
        assert.equal(compatiblePlayers(game.id,observation,html.replace(locator.serverUrl,bad)).length,0);
      }
    }
  }
  assert.equal(ids.size,2);
});

test('Buff discovery reports two collected players without claiming blocked media works',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'buff-live-'));
  let clock=at;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,sources:[source],
    readSchedule:async source=>({games:source.id==='nfl'?[game]:[],league:source.league,at:clock}),
    readHtml:async url=>fixture(url===source.url?'catalog':url.includes('detroit')?'detroit':'carolina'),
    probeCandidate:async()=>({kind:'unavailable',reason:'upstream'}),
  });
  try{
    await coordinator.refresh();
    for(let i=0;i<60;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    const snapshot=await coordinator.command({kind:'sources'});
    assert.equal(snapshot.kind,'sources');
    if(snapshot.kind==='sources'){
      assert.equal(snapshot.snapshot.sources[0].matchedGameCount,1);
      const row=snapshot.snapshot.games.find(row=>row.gameId===game.id);
      assert.ok(row);
      assert.equal(row.candidates.length,2);
      assert.equal(row.workingChoiceCount,0);
      assert.ok(row.candidates.every(candidate=>candidate.availability.kind==='unavailable'));
      assert.ok(row.sourceLinks.every(link=>link.sourceId==='buffstream-nfl'&&link.evidence.kind==='collected'));
    }
    clock+=90001;
    const stale=await coordinator.command({kind:'sources'});
    assert.equal(stale.kind,'sources');
    if(stale.kind==='sources')assert.equal(stale.snapshot.sources[0].matchedGameCount,0);
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
