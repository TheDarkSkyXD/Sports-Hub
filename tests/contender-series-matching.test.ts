import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSourceEventMatcher,matchObservation} from '../lib/football/domain/matching.ts';
import {GameSchema,type Observation} from '../lib/football/shared.ts';

const now=Date.parse('2026-10-12T18:00:00Z');
const kickoff=Date.parse('2026-10-13T23:00:00Z');
const game=GameSchema.parse({id:'ufc-600060741',league:'ufc',
  name:"Dana White's Contender Series: Season 10, Week 10",date:new Date(kickoff).toISOString(),
  combat:{eventId:'600060741'},status:'pre',lifecycle:'scheduled',detail:'Scheduled'});
function observation(title:string,start:number|null=kickoff):Observation {
  return {id:'streamed:contender-series',sourceId:'streamed',url:'https://streamed.st/watch/contender-series',
    title,league:'ufc',teams:null,kickoff:start,rawTime:start===null?'':new Date(start).toISOString(),
    observedAt:now,parserVersion:1};
}

test('published Contender Series title variants match the scheduled card',()=>{
  const match=createSourceEventMatcher([game]);
  for(const title of ["Dana White's Contender Series",'Dana Whites Contender Series vs Live',
    'Dana White’s Contender Series vs Live Broadcast',"Dana White's Contender Series Live Stream",
    'Dana Whites Contender Series: Season 10, Week 10',"Dana White's Contender Series: Week 10",
    "Dana White's Contender Series: Season 10"]){
    assert.deepEqual(match(observation(title),{undated:'none',externalGameId:null},now).match,
      {kind:'matched',gameId:'ufc-600060741'},title);
  }
});

test('explicit Contender Series season and week cannot match a conflicting card',()=>{
  assert.deepEqual(matchObservation(observation("Dana White's Contender Series: Season 10, Week 10"),[game],now),
    {kind:'matched',gameId:'ufc-600060741'});
  for(const title of ["Dana White's Contender Series: Week 9","Dana White's Contender Series: Season 9",
    "Dana White's Contender Series: Season 10, Week 11"]){
    assert.deepEqual(matchObservation(observation(title),[game],now),
      {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]},title);
  }
});

test('a generic Contender Series title requires exactly one card in the kickoff window',()=>{
  const second=GameSchema.parse({...game,id:'ufc-600060742',name:"Dana White's Contender Series: Season 10, Week 11",
    combat:{eventId:'600060742'}});
  assert.deepEqual(matchObservation(observation("Dana White's Contender Series"),[game,second],now),
    {kind:'unmatched',reason:'ambiguous-matchup',possibleGameIds:['ufc-600060741','ufc-600060742']});
  assert.deepEqual(matchObservation(observation("Dana White's Contender Series: Week 10"),[game,second],now),
    {kind:'matched',gameId:'ufc-600060741'});
});

test('Contender Series aliases preserve kickoff verification and the three-hour bound',()=>{
  const title="Dana White's Contender Series";
  assert.deepEqual(matchObservation(observation(title,kickoff+3*60*60_000),[game],now),
    {kind:'matched',gameId:'ufc-600060741'});
  assert.deepEqual(matchObservation(observation(title,kickoff+3*60*60_000+1),[game],now),
    {kind:'unmatched',reason:'conflicting-date',possibleGameIds:['ufc-600060741']});
  assert.deepEqual(matchObservation(observation(title,null),[game],now),
    {kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:[]});
});

test('Contender Series aliases cannot erase extra title identity or invent missing season evidence',()=>{
  assert.deepEqual(matchObservation(observation("Dana White's Contender Series"),[game],now),
    {kind:'matched',gameId:'ufc-600060741'});
  for(const title of ["Dana White's Contender Series: Other Event","Dana White's Contender Series Highlights",
    'UFC Fight Night']){
    assert.deepEqual(matchObservation(observation(title),[game],now),
      {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]},title);
  }
  const undetailed=GameSchema.parse({...game,name:"Dana White's Contender Series"});
  assert.deepEqual(matchObservation(observation("Dana White's Contender Series: Week 10"),[undetailed],now),
    {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
});
