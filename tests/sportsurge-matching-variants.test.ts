import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {z} from 'zod';
import {createSourceEventMatcher,matchObservation} from '../lib/football/domain/matching.ts';
import {listingEventEvidence} from '../lib/football/source-registry.ts';
import {GameSchema,ObservationSchema,isCombatGame,isMatchupGame} from '../lib/football/shared.ts';

const fixture=z.object({now:z.number(),games:z.array(GameSchema),observations:z.array(ObservationSchema)}).parse(
  JSON.parse(readFileSync(new URL('./fixtures/sportsurge-matching-variants.json',import.meta.url),'utf8')));
const expected=new Map([
  ['Brigham Young Cougars vs Notre Dame Fighting Irish','ncaaf-401856809'],
  ['Maple Leaf vs Islanders','nhl-401892523'],['Canadeins vs Sabres','nhl-401892524'],
  ['Daniel Dubois vs Fabio Wardley','boxing-26306077464387'],
  ['UFC Fight Night Buckley vs Mike Malott','ufc-600060773'],['Jamel Herring vs John Dodson','boxing-218065792495125'],
]);

test('captured Sportsurge spellings and fighter titles resolve to the six existing scheduled events',async context=>{
  assert.equal(fixture.games.length,6);assert.equal(fixture.observations.length,9);
  const match=createSourceEventMatcher(fixture.games);
  for(const observation of fixture.observations)await context.test(`${observation.sourceId}: ${observation.title}`,()=>assert.deepEqual(
    match(observation,listingEventEvidence(observation.sourceId),fixture.now).match,
    {kind:'matched',gameId:expected.get(observation.title)}));
});

test('reviewed NHL spellings require the exact franchise and league',()=>{
  for(const observation of fixture.observations.filter(row=>row.league==='nhl')){
    const game=fixture.games.find(row=>row.id===expected.get(observation.title));assert.ok(game);assert.ok(isMatchupGame(game));
    for(const id of [undefined,'espn:nhl:99'])assert.deepEqual(matchObservation(observation,[{...game,home:{...game.home,id}}],fixture.now),
      {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
    const wrongLeague=GameSchema.parse({...game,id:game.id.replace('nhl-','nba-'),league:'nba'});
    assert.deepEqual(matchObservation({...observation,league:'nba'},[wrongLeague],fixture.now),
      {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
    assert.deepEqual(matchObservation({...observation,kickoff:(observation.kickoff??0)+86400000},[game],fixture.now),
      {kind:'unmatched',reason:'conflicting-date',possibleGameIds:[game.id]});
  }
});

test('fighter pairs preserve explicit card and rematch identity, ambiguity, and kickoff bounds',()=>{
  const observation=fixture.observations.find(row=>row.title==='Daniel Dubois vs Fabio Wardley');assert.ok(observation);
  const game=fixture.games.find(row=>row.id===expected.get(observation.title));assert.ok(game);assert.ok(isCombatGame(game));
  assert.deepEqual(matchObservation({...observation,title:'Dubois vs Wardley 2'},[game],fixture.now),{kind:'matched',gameId:game.id});
  for(const title of ['Dubois vs Wardley 1','Dubois vs Wardley 3','Daniel Dubois vs Someone Else','Daniel Dubois vs Fabio Wardley Highlights'])
    assert.deepEqual(matchObservation({...observation,title},[game],fixture.now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  const full=GameSchema.parse({...game,name:'Daniel Dubois vs Fabio Wardley'});
  assert.deepEqual(matchObservation({...observation,title:'Daniel Dubois vs James Wardley'},[full],fixture.now),
    {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  const another=GameSchema.parse({...game,id:'boxing-123',combat:{eventId:'123'}});
  assert.deepEqual(matchObservation(observation,[game,another],fixture.now),
    {kind:'unmatched',reason:'ambiguous-matchup',possibleGameIds:[game.id,another.id]});
  assert.deepEqual(matchObservation({...observation,kickoff:Date.parse(game.date)+90*60000+1},[game],fixture.now),
    {kind:'unmatched',reason:'conflicting-date',possibleGameIds:[game.id]});
  const ufc=fixture.games.find(row=>row.league==='ufc');assert.ok(ufc);
  const numbered=GameSchema.parse({...ufc,name:'UFC 320: Buckley vs Malott'});
  assert.deepEqual(matchObservation({...observation,league:'ufc',title:'UFC 32: Buckley vs Mike Malott',kickoff:Date.parse(ufc.date)},[numbered],fixture.now),
    {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
});
