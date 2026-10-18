import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {z} from 'zod';
import {COLLEGE_TEAM_CATALOG} from '../lib/football/domain/college-teams.generated.ts';
import {matchObservation,normalizedName} from '../lib/football/domain/matching.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const team=z.object({id:z.string(),name:z.string(),location:z.string(),short:z.string()});
const fixture=z.object({source:z.string().url(),events:z.array(z.object({title:z.string(),id:z.string(),name:z.string(),date:z.string(),teams:z.tuple([team,team])}))}).parse(
  JSON.parse(readFileSync(new URL('./fixtures/college-division-aliases-20261017.json',import.meta.url),'utf8')));

test('reviewed Sportsurge names resolve to eighteen official DII/III games with unique alias owners',async context=>{
  assert.equal(fixture.events.length,18);
  const owners=new Map<string,Set<string>>();
  for(const entry of COLLEGE_TEAM_CATALOG)for(const alias of entry.aliases){
    const key=normalizedName(alias),ids=owners.get(key)??new Set<string>();ids.add(entry.id);owners.set(key,ids);
  }
  for(const event of fixture.events)await context.test(event.title,()=>{
    const [home,away]=event.teams.map(value=>({...value,abbreviation:value.short,color:'112233',score:null}));
    const game:Game={id:`ncaaf-${event.id}`,league:'ncaaf',name:event.name,date:event.date,home,away,
      status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false};
    const teams=event.title.split(/\s+vs\s+/i);assert.equal(teams.length,2);
    const observation:Observation={id:`sportsurge:${event.id}`,sourceId:'sportsurge',url:fixture.source,title:event.title,league:'ncaaf',
      teams:[teams[0],teams[1]],kickoff:Date.parse(event.date),rawTime:event.date,observedAt:Date.parse(event.date),parserVersion:1};
    assert.deepEqual(matchObservation(observation,[game],Date.parse(event.date)),{kind:'matched',gameId:game.id});
    for(const name of teams)assert.equal(owners.get(normalizedName(name))?.size,1,name);
    assert.deepEqual(matchObservation({...observation,kickoff:Date.parse(event.date)+86400000},[game],Date.parse(event.date)),
      {kind:'unmatched',reason:'conflicting-date',possibleGameIds:[game.id]});
  });
});
