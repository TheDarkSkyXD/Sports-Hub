import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFinishedGameMatcher} from '../lib/football/domain/matching.ts';
import type {Game,Observation,SourceEventBinding} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T18:00:00Z');
const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:null});
const game:Game={id:'fixture',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),
  home:team('Home Harbor Hawks'),away:team('Away Valley Bears'),status:'in',lifecycle:'live',detail:'Live',redzone:false};
const observation:Observation={id:'listing',sourceId:'fixture',url:'https://fixture.example/game',title:game.name,
  league:'nfl',teams:['Away Valley Bears','Home Harbor Hawks'],kickoff:at,rawTime:'',observedAt:at,parserVersion:3};
const binding:SourceEventBinding={sourceId:observation.sourceId,eventId:'event',url:observation.url,
  league:'nfl',teams:['Away Valley Bears','Home Harbor Hawks'],gameId:game.id,observedAt:at};

test('finished-game filtering keeps listings when the schedule has no finals',context=>{
  const started=performance.now(),cpu=process.cpuUsage();
  const finished=createFinishedGameMatcher([game,{...game,id:'scheduled',status:'pre',lifecycle:'scheduled'}]);
  const results=Array.from({length:12},()=>[
    finished.finishedGameId(observation,at),
    finished.finishedGameId({...observation,teams:['Unknown','Different']},at,'missing'),
    finished.finishedBoundEvent({...observation,kickoff:null},'event',[binding]),
  ]);
  assert.deepEqual(results,Array.from({length:12},()=>[null,null,null]));
  const used=process.cpuUsage(cpu);
  context.diagnostic(JSON.stringify({games:2,lookups:36,workload:'construct-and-filter',
    wallMs:performance.now()-started,cpuMs:(used.user+used.system)/1000}));
});

test('a replacement schedule with finals still applies ambiguity and bound ownership',context=>{
  const started=performance.now(),cpu=process.cpuUsage();
  const undated={...observation,kickoff:null};
  const active=createFinishedGameMatcher([game]);
  assert.equal(active.finishedGameId(observation,at),null);
  const final={...game,status:'post',lifecycle:'final' as const,detail:'Final'};
  const finished=createFinishedGameMatcher([final]);
  assert.equal(finished.finishedGameId(observation,at),'fixture');
  assert.equal(finished.finishedBoundEvent(undated,'event',[binding]),'fixture');
  assert.equal(finished.finishedGameId(observation,at,'different'),null);
  assert.equal(finished.finishedBoundEvent(undated,'event',[{...binding,gameId:'different'}]),null);
  const ambiguous=createFinishedGameMatcher([final,{...game,id:'second'}]);
  assert.equal(ambiguous.finishedGameId(observation,at),null);
  assert.equal(ambiguous.finishedBoundEvent(undated,'event',[binding]),null);
  const used=process.cpuUsage(cpu);
  context.diagnostic(JSON.stringify({workload:'replace-schedule-and-filter',
    wallMs:performance.now()-started,cpuMs:(used.user+used.system)/1000}));
});
