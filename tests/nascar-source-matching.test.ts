import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createFixtureCollector,SOURCES} from '../lib/football/adapters/sources.ts';
import {createSourceEventMatcher,detailCandidateGameIds,matchObservation} from '../lib/football/domain/matching.ts';
import type {Observation,RaceGame} from '../lib/football/shared.ts';

const now=Date.parse('2026-10-11T17:15:00Z');
const cup:RaceGame={id:'nascar-cup-202610110021',league:'nascar-cup',name:'NASCAR Cup Series at Charlotte',
  date:'2026-10-11T19:00:00Z',race:{eventId:'202610110021',sessionId:'202610110021',session:'race',round:'Charlotte'},
  lifecycle:'scheduled',status:'pre',detail:'Scheduled'};
function published():Observation {
  const source=SOURCES.find(row=>row.id==='sportsfeed24');
  assert.ok(source);
  const body=readFileSync(new URL('./fixtures/broad-sources/sportsfeed24-F1.json',import.meta.url),'utf8');
  const rows=createFixtureCollector().parseListings(source,`[${body}]`,now).observations;
  const row=rows.find(row=>row.title==='NASCAR Charlotte Motor Speedway vs Live');
  assert.ok(row);
  return row;
}

test('a published NASCAR track listing without a series binds only to a unique dated NASCAR race',()=>{
  const row=published();
  assert.equal(row.league,'motorsport');
  assert.equal(row.kickoff,Date.parse('2026-10-11T20:00:00Z'));
  assert.deepEqual(matchObservation(row,[cup],now),{kind:'matched',gameId:'nascar-cup-202610110021'});
  const truck:RaceGame={...cup,id:'nascar-truck-202610094261',league:'nascar-truck'};
  assert.deepEqual(matchObservation(row,[truck],now),{kind:'matched',gameId:'nascar-truck-202610094261'});
  assert.deepEqual(matchObservation(row,[cup,truck],now),{
    kind:'unmatched',reason:'ambiguous-race',possibleGameIds:['nascar-cup-202610110021','nascar-truck-202610094261'],
  });
});

test('generic NASCAR track evidence cannot erase a date, venue, session, or explicit series conflict',()=>{
  const row=published();
  assert.deepEqual(matchObservation(row,[cup],now),{kind:'matched',gameId:'nascar-cup-202610110021'});
  for(const changed of [
    {...row,kickoff:Date.parse('2026-10-12T20:00:00Z')},
    {...row,title:'NASCAR Phoenix Raceway vs Live'},
    {...row,title:'NASCAR Xfinity Charlotte Motor Speedway vs Live'},
    {...row,title:'NASCAR Charlotte Motor Speedway Practice vs Live'},
    {...row,title:'MotoGP Charlotte Motor Speedway vs Live'},
    {...row,league:'nascar-truck' as const},
    {...row,kickoff:null},
  ])assert.equal(matchObservation(changed,[cup],now).kind,'unmatched',JSON.stringify(changed));
});

test('a published motorsport track without a series still requires one dated NASCAR race',()=>{
  const row={...published(),title:'Charlotte Motor Speedway',sourceId:'streameast',kickoff:Date.parse(cup.date)};
  assert.deepEqual(matchObservation(row,[cup],now),{kind:'matched',gameId:cup.id});
  const truck:RaceGame={...cup,id:'nascar-truck-202610110022',league:'nascar-truck'};
  assert.deepEqual(matchObservation(row,[cup,truck],now),{
    kind:'unmatched',reason:'ambiguous-race',possibleGameIds:[cup.id,truck.id],
  });
  for(const title of ['Charlotte','Charlotte Motor Speedway Qualifying','MotoGP Charlotte Motor Speedway']) {
    assert.equal(matchObservation({...row,title},[cup],now).kind,'unmatched',title);
  }
});

test('explicit NASCAR league metadata cannot override a contradictory race series title',()=>{
  const row={...published(),league:'nascar-cup' as const,kickoff:Date.parse(cup.date)};
  assert.deepEqual(matchObservation(row,[cup],now),{kind:'matched',gameId:cup.id});
  for(const title of ['NASCAR Truck Series at Charlotte','NASCAR Xfinity Series at Charlotte',
    'MotoGP Charlotte Grand Prix','Formula 1 Charlotte Grand Prix','F1 Charlotte Grand Prix']) {
    assert.deepEqual(matchObservation({...row,title},[cup],now),{
      kind:'unmatched',reason:'unknown-race',possibleGameIds:[],
    },title);
  }
  const truck:RaceGame={...cup,id:'nascar-truck-202610110022',league:'nascar-truck'};
  assert.equal(matchObservation({...row,league:'nascar-truck',title:'NASCAR Cup Series at Charlotte'},[truck],now).kind,'unmatched');
});

for(const sourceId of ['crichd','sportsbite'])test(`${sourceId} listings cannot attach to unsupported NASCAR races`,()=>{
  const row={...published(),sourceId};
  assert.deepEqual(createSourceEventMatcher([cup])(row,{undated:'none',externalGameId:null},now),{
    kind:'rejected',reason:'unknown-race',match:{kind:'unmatched',reason:'unknown-race',possibleGameIds:[]},
  },sourceId);
});

test('an explicit NASCAR listing can request its dated detail without claiming an undated race match',()=>{
  const row:Observation={...published(),sourceId:'sportsurge',title:'2026 NASCAR Cup Series Playoff at Charlotte Road Course',
    league:'nascar-cup',kickoff:null};
  const result=matchObservation(row,[cup],now);
  assert.equal(result.kind,'unmatched');
  assert.deepEqual(detailCandidateGameIds(result),[cup.id]);
  assert.equal(createSourceEventMatcher([cup])(row,{undated:'published-listing',externalGameId:null},now).kind,'possible');
  for(const changed of [{...row,title:'NASCAR Cup Series at Phoenix'},
    {...row,title:'NASCAR Truck Series at Charlotte'},{...row,league:'nascar-truck' as const},
    {...row,title:'NASCAR Cup Series at Charlotte Qualifying'}]){
    assert.deepEqual(detailCandidateGameIds(matchObservation(changed,[cup],now)),[]);
  }
  assert.deepEqual(matchObservation({...row,kickoff:Date.parse('2026-10-11T20:00:00Z')},[cup],now),{kind:'matched',gameId:cup.id});
  assert.equal(matchObservation({...row,kickoff:Date.parse('2026-10-12T20:00:00Z')},[cup],now).kind,'unmatched');
});
