import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFinishedGameMatcher } from '../lib/football/domain/matching.ts';
import type { Game, Observation, SourceEventBinding } from '../lib/football/shared.ts';

const now=Date.parse('2026-10-08T22:00:00Z');
const kickoff=now-60*60_000;
const team=(id:string,name:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const final:Game={id:'nfl-101',league:'nfl',name:'Bears at Packers',date:new Date(kickoff).toISOString(),
  home:team('packers','Green Bay Packers'),away:team('bears','Chicago Bears'),status:'post',lifecycle:'final',
  detail:'Final',redzone:false};
const dated:Observation={id:'sportsurge-v2:101',sourceId:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-101-nfl-bears-packers',
  title:'Bears at Packers',league:'nfl',teams:['Chicago Bears','Green Bay Packers'],kickoff,
  rawTime:new Date(kickoff).toISOString(),observedAt:now-2*60*60_000,parserVersion:1};

test('finished matching confirms only the same dated game or an exact unambiguous bound event',()=>{
  const finished=createFinishedGameMatcher([final]);
  assert.equal(finished.finishedGameId(dated,now),'nfl-101');
  assert.equal(finished.finishedGameId(dated,now,'nfl-999'),null);

  const undated={...dated,kickoff:null,rawTime:null};
  const binding:SourceEventBinding={sourceId:undated.sourceId,eventId:'nfl:101',url:undated.url,
    league:'nfl',teams:['Green Bay Packers','Chicago Bears'],gameId:final.id,observedAt:now};
  assert.equal(finished.finishedBoundEvent(undated,'nfl:101',[binding]),'nfl-101');
  assert.equal(finished.finishedBoundEvent({...undated,url:'https://v2.sportsurge.net/watch-102-nfl'},'nfl:101',[binding]),null);
  assert.equal(finished.finishedBoundEvent({...undated,teams:['Chicago Bears','Detroit Lions']},'nfl:101',[binding]),null);
  assert.equal(finished.finishedBoundEvent(undated,'nfl:102',[binding]),null);
  assert.equal(createFinishedGameMatcher([final,{...final,id:'nfl-102'}])
    .finishedBoundEvent(undated,'nfl:101',[binding]),null);
});
