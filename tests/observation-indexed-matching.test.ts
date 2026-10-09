import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createObservationMatcher } from '../lib/football/domain/matching.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T22:00:00Z');
const team=(id:string,name:string):Game['home']=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const first:Game={id:'100',league:'nfl',name:'Bears at Packers',date:new Date(at).toISOString(),
  home:team('packers','Green Bay Packers'),away:team('bears','Chicago Bears'),status:'in',lifecycle:'live',
  detail:'Q1',redzone:false,partitions:['nfl']};
const second:Game={...first,id:'101',date:new Date(at+24*60*60_000).toISOString()};
const otherLeague:Game={...first,id:'nba-100',league:'nba',partitions:['nba']};
const observation:Observation={id:'listing:100',sourceId:'sportsurge',url:'https://example.com/100',title:first.name,
  league:'nfl',teams:['Chicago Bears','Green Bay Packers'],kickoff:at,rawTime:new Date(at).toISOString(),
  observedAt:at,parserVersion:1};

test('indexed matching keeps duplicate matchups ordered and separates league, date, stale, and final decisions',()=>{
  const match=createObservationMatcher([second,otherLeague,first]);
  assert.deepEqual(match({...observation,kickoff:null},at),
    {kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:['101','100']});
  assert.deepEqual(match(observation,at),{kind:'matched',gameId:'100'});
  assert.deepEqual(match({...observation,teams:['Green Bay Packers','Chicago Bears']},at),
    {kind:'matched',gameId:'100'});
  assert.deepEqual(match({...observation,league:'nba'},at),{kind:'matched',gameId:'nba-100'});
  assert.deepEqual(match({...observation,observedAt:at-31*60_000},at),
    {kind:'unmatched',reason:'stale-observation',possibleGameIds:[]});
  const finished=createObservationMatcher([{...first,lifecycle:'final',status:'post',
    finalObservedAt:at,graceEndsAt:at+60_000}]);
  assert.deepEqual(finished(observation,at),{kind:'unmatched',reason:'finished-game',possibleGameIds:['100']});
});
