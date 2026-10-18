import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {z} from 'zod';
import {createFixtureCollector,SOURCES} from '../lib/football/adapters/sources.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import type {Game} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T21:10:00Z');
const fixture=(name:string)=>readFileSync(new URL(`./fixtures/broad-sources/${name}`,import.meta.url),'utf8');
const source=(id:string)=>{
  const result=SOURCES.find(item=>item.id===id);
  assert.ok(result,id);
  return result;
};
const sportsfeedCatalog=z.object({subCategories:z.array(z.object({games:z.array(z.object({
  teamA:z.string(),teamB:z.string(),sourceLink:z.string(),matchDate:z.string(),
}).passthrough())}))});

test('SportsFeed24 retains its catalog kickoff through detail enrichment and matching',()=>{
  const collector=createFixtureCollector();
  const body=fixture('sportsfeed24-today.json');
  const catalog=sportsfeedCatalog.parse(JSON.parse(body));
  const listed=catalog.subCategories.flatMap(category=>category.games).find(game=>game.teamA==='Dallas Cowboys');
  assert.ok(listed);
  const observation=collector.parseListings(source('sportsfeed24'),`[${body}]`,at).observations.find(row=>
    row.title==='Dallas Cowboys vs Tampa Bay Buccaneers');
  assert.ok(observation);
  assert.equal(observation.kickoff,Date.parse('2026-10-08T23:18:18Z'));
  const enriched=collector.enrichObservation(observation,JSON.stringify({game:listed}));
  assert.deepEqual(enriched,observation);
  const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
  const game:Game={id:'401892458',league:'nfl',name:observation.title,date:'2026-10-08T23:18:18Z',
    away:team('Dallas Cowboys'),home:team('Tampa Bay Buccaneers'),status:'pre',lifecycle:'scheduled',detail:'',redzone:false};
  assert.deepEqual(matchObservation(enriched,[game],at),{kind:'matched',gameId:game.id});
  const changed=JSON.stringify({game:{...listed,teamA:'Other Team'}});
  assert.equal(collector.missingPlayerReason(collector.enrichObservation(observation,changed),changed),'conflicting-game');
});

test('JSON catalog details cannot replace listing times with embedded HTML metadata',async()=>{
  const collector=createFixtureCollector();
  for(const [id,name] of [['streamed','streamed.json'],['livesportpro','livesportpro.json'],
    ['sportsbite','sportsbite.json']] as const){
    const listing=collector.parseListings(source(id),fixture(name),at);
    const observation=listing.observations[0];
    assert.ok(observation,id);
    assert.notEqual(observation.kickoff,null,id);
    const detail=await collector.readHtml(observation.url,new AbortController().signal);
    const withMetadata=detail.trim().replace(/}$/,',"description":"<time datetime=\'2026-10-09T00:00:00Z\'>Other time</time>"}');
    assert.deepEqual(collector.enrichObservation(observation,withMetadata),observation,id);
    const changed=detail.replace(observation.title,'Other Event');
    assert.equal(collector.missingPlayerReason(collector.enrichObservation(observation,changed),changed),'conflicting-game',id);
  }
});
