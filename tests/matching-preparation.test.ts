import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createObservationMatcher} from '../lib/football/domain/matching.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T18:00:00Z');
test('team aliases match the same game while stale observations expire',context=>{
 const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:null,
  aliases:Array.from({length:40},(_,index)=>name+' alias '+index)});
 const game:Game={id:'fixture',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),
  home:team('Home Harbor Hawks'),away:team('Away Valley Bears'),status:'in',lifecycle:'live',detail:'Live',redzone:false,partitions:['nfl']};
 const observation:Observation={id:'listing',sourceId:'fixture',url:'https://fixture.example/game',title:game.name,
  league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,rawTime:'',observedAt:at,parserVersion:3};
 const started=performance.now(),cpu=process.cpuUsage();
 const match=createObservationMatcher([game]);
 assert.deepEqual(match(observation,at),{kind:'matched',gameId:'fixture'});
 assert.deepEqual(match({...observation,teams:['Away Valley Bears alias 39','Home Harbor Hawks alias 39']},at),{kind:'matched',gameId:'fixture'});
 assert.deepEqual(match(observation,at+30*60_000+1),{kind:'unmatched',reason:'stale-observation',possibleGameIds:[]});
 const used=process.cpuUsage(cpu);
 context.diagnostic(JSON.stringify({aliasesPerTeam:40,lookups:3,workload:'construct-and-match',
  wallMs:performance.now()-started,cpuMs:(used.user+used.system)/1000}));
});
