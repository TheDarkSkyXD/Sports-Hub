import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COLLEGE_TEAM_CATALOG } from '../lib/football/domain/college-teams.generated.ts';
import { matchObservation, normalizedName } from '../lib/football/domain/matching.ts';
import { parseScoreboard } from '../lib/sunday.ts';
import { buildCatalog } from '../scripts/generate-college-team-catalog.mjs';
import type { Game, Observation } from '../lib/football/shared.ts';

const now = Date.parse('2026-09-26T16:00:00Z');
const opponent: Game['away'] = {id:'fixture:opponent',name:'Synthetic Opponent',short:'Synthetic Opponent',abbreviation:'SYNOP',aliases:['Synthetic Opponent'],color:'112233',score:null};
const team = (id: string, name: string, aliases: string[] = []): Game['home'] => ({id,name,short:name,abbreviation:name,aliases,color:'112233',score:null});
const game = (id: string, home: Game['home'], away: Game['away'] = opponent): Game => ({id,league:'ncaaf',name:`${home.name} vs ${away.name}`,date:new Date(now).toISOString(),home,away,status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false});
const observation = (first: string, second = 'Synthetic Opponent', kickoff: number | null = now): Observation => ({id:'fixture:event',sourceId:'fixture',url:'https://example.org/event',title:`${first} vs ${second}`,teams:[first,second],league:'ncaaf',rawTime:null,kickoff,observedAt:now,parserVersion:1});

test('Albany matches UAlbany against Delaware State without matching Albany State',()=>{
  const delawareState=team('espn:ncaaf:2169','Delaware State Hornets');
  const ualbany=game('ualbany',team('espn:ncaaf:399','UAlbany Great Danes'),delawareState);
  const albanyState=game('albany-state',team('espn:ncaaf:2013','Albany State Golden Rams'),delawareState);
  const listing={...observation('Albany','Delaware State'),sourceId:'tvapp',url:'https://tvapp1.pk/watch/2594008'};
  assert.deepEqual(matchObservation(listing,[ualbany,albanyState],now),{kind:'matched',gameId:'ualbany'});
  assert.deepEqual(matchObservation(listing,[albanyState],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  assert.deepEqual(matchObservation(observation('Albany State','Delaware State'),[ualbany,albanyState],now),{kind:'matched',gameId:'albany-state'});
  assert.deepEqual(matchObservation(observation('Albany State','Delaware State'),[ualbany],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
});

test('every 2026 FBS/FCS member and official catalog alias resolves to its owner or fails closed on collision', () => {
  const coverage = JSON.parse(readFileSync(new URL('../lib/football/domain/college-teams.coverage.json',import.meta.url),'utf8'));
  assert.equal(coverage.fbs,148);
  assert.equal(coverage.fcs,130);
  assert.equal(coverage.members,278);
  assert.equal(coverage.catalog,775);
  assert.equal(COLLEGE_TEAM_CATALOG.length,775);
  const byId = new Map(COLLEGE_TEAM_CATALOG.map(entry => [entry.id,entry]));
  for (const id of coverage.memberIds) assert.ok(byId.has(id),`missing membership ${id}`);
  const owners = new Map<string,Set<string>>();
  for (const entry of COLLEGE_TEAM_CATALOG) for (const alias of entry.aliases) {
    const key = normalizedName(alias);
    const set = owners.get(key) || new Set<string>();
    set.add(entry.id);
    owners.set(key,set);
  }
  for (const entry of COLLEGE_TEAM_CATALOG) {
    const scheduled = game(`game-${entry.id}`,team(entry.id,entry.aliases[0]));
    for (const alias of entry.aliases) {
      const result = matchObservation(observation(alias),[scheduled],now);
      if (!normalizedName(alias)) assert.deepEqual(result,{kind:'unmatched',reason:'not-a-matchup',possibleGameIds:[]},`${entry.id}: ${alias}`);
      else if (owners.get(normalizedName(alias))?.size === 1) assert.deepEqual(result,{kind:'matched',gameId:scheduled.id},`${entry.id}: ${alias}`);
      else assert.deepEqual(result,{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]},`${entry.id}: ${alias}`);
    }
  }
});

test('UND and NDSU remain distinct across abbreviations, full names, history, order, and kickoff', () => {
  const northDakota = game('und',team('espn:ncaaf:155','North Dakota Fighting Hawks'));
  const northDakotaState = game('ndsu',team('espn:ncaaf:2449','North Dakota State Bison'));
  const games = [northDakota,northDakotaState];
  for (const alias of ['UND','North Dakota Fighting Hawks','North Dakota Fighting Sioux']) {
    assert.deepEqual(matchObservation(observation(alias),games,now),{kind:'matched',gameId:'und'});
    assert.deepEqual(matchObservation(observation('Synthetic Opponent',alias),games,now),{kind:'matched',gameId:'und'});
    assert.deepEqual(matchObservation(observation(alias),[northDakotaState],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  }
  for (const alias of ['NDSU','North Dakota State Bison']) {
    assert.deepEqual(matchObservation(observation(alias),games,now),{kind:'matched',gameId:'ndsu'});
    assert.deepEqual(matchObservation(observation(alias),[northDakota],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  }
  assert.deepEqual(matchObservation(observation('North Dakota Fighting Sioux','Synthetic Opponent',null),games,now),{kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:['und']});
  assert.deepEqual(matchObservation(observation('UND','Synthetic Opponent',now + 24 * 3600000),games,now),{kind:'unmatched',reason:'conflicting-date',possibleGameIds:['und']});
});

test('off-window owners block Charlotte and SOU while live-only Rio Grande keeps its own identity', () => {
  const charlotte = game('charlotte',team('espn:ncaaf:2429','Charlotte 49ers',['Charlotte']));
  const southern = game('southern',team('espn:ncaaf:2582','Southern Jaguars',['SOU']));
  assert.deepEqual(matchObservation(observation('Charlotte'),[charlotte],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  assert.deepEqual(matchObservation(observation('SOU'),[southern],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  const rioGrande = game('rio-grande',team('espn:ncaaf:131239','Rio Grande Red Storm'));
  const utrgv = game('utrgv',team('espn:ncaaf:292','UT Rio Grande Valley Vaqueros'));
  assert.deepEqual(matchObservation(observation('Rio Grande Red Storm'),[rioGrande,utrgv],now),{kind:'matched',gameId:'rio-grande'});
  assert.deepEqual(matchObservation(observation('UT Rio Grande Valley Vaqueros'),[rioGrande,utrgv],now),{kind:'matched',gameId:'utrgv'});
  assert.deepEqual(matchObservation(observation('Rio Grande Red Storm'),[utrgv],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
});

test('USD and SDSU are ambiguous between their verified schools even when one owner is off-week', () => {
  const southDakota = game('south-dakota',team('espn:ncaaf:233','South Dakota Coyotes'));
  const sanDiego = game('san-diego',team('espn:ncaaf:301','San Diego Toreros'));
  const southDakotaState = game('south-dakota-state',team('espn:ncaaf:2571','South Dakota State Jackrabbits'));
  const sanDiegoState = game('san-diego-state',team('espn:ncaaf:21','San Diego State Aztecs'));
  for (const candidate of [southDakota,sanDiego]) assert.deepEqual(matchObservation(observation('USD'),[candidate],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  for (const candidate of [southDakotaState,sanDiegoState]) assert.deepEqual(matchObservation(observation('SDSU'),[candidate],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  assert.deepEqual(matchObservation(observation('South Dakota Coyotes'),[southDakota],now),{kind:'matched',gameId:'south-dakota'});
  assert.deepEqual(matchObservation(observation('San Diego Toreros'),[sanDiego],now),{kind:'matched',gameId:'san-diego'});
});

test('verified observed names match both previously unknown opponents without altering display fields', () => {
  const event = (id: string, homeId: string, homeName: string, awayId: string, awayName: string) => ({id,date:new Date(now).toISOString(),status:{type:{state:'pre',name:'STATUS_SCHEDULED'}},competitions:[{competitors:[{homeAway:'home',team:{id:homeId,displayName:homeName}},{homeAway:'away',team:{id:awayId,displayName:awayName}}]}]});
  const parsed = parseScoreboard({events:[event('1','2755','Grambling Tigers','2504','Prairie View A&M Panthers'),event('2','152','NC State Wolfpack','2026','App State Mountaineers')]},'ncaaf');
  assert.equal(parsed[0].home.name,'Grambling Tigers');
  assert.deepEqual(matchObservation(observation('Grambling State','Prairie View A and M'),parsed,now),{kind:'matched',gameId:'ncaaf-1'});
  assert.deepEqual(matchObservation(observation('North Carolina State Wolfpack','Appalachian State Mountaineers'),parsed,now),{kind:'matched',gameId:'ncaaf-2'});
  assert.deepEqual(matchObservation(observation('Grambling State','Appalachian State Mountaineers'),parsed,now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  assert.deepEqual(matchObservation(observation('Grambling State','Prairie View A and M',now + 24 * 3600000),parsed,now),{kind:'unmatched',reason:'conflicting-date',possibleGameIds:['ncaaf-1']});
  assert.deepEqual(matchObservation({...observation('Grambling State','Prairie View A and M'),observedAt:now-31*60_000},parsed,now),{kind:'unmatched',reason:'stale-observation',possibleGameIds:[]});
  assert.deepEqual(matchObservation(observation('Grambling State','Prairie View A and M'),[{...parsed[0],status:'post',lifecycle:'final',finalObservedAt:now,graceEndsAt:now+300000}],now),{kind:'unmatched',reason:'finished-game',possibleGameIds:['ncaaf-1']});
});

test('generator refuses partial membership, duplicate IDs, and a short bulk response without output', () => {
  const ref = (id: string) => ({$ref:`https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/teams/${id}`});
  const membership = (ids: string[]) => ({count:ids.length,pageCount:1,pageIndex:1,items:ids.map(ref)});
  const meta = (id: string, abbreviation: string) => ({id,displayName:`School ${id} Wildcats`,location:`School ${id}`,shortDisplayName:`School ${id}`,abbreviation});
  const input = {season:2026,fbs:membership(['1']),fcs:membership(['2']),bulkTeams:[{team:meta('1','OLD')}],coreTeams:[meta('1','NEW'),meta('2','TWO')],overrides:[],expectedBulkCount:1};
  const result = buildCatalog(input);
  assert.deepEqual(result.teams[0].aliases,['School 1 Wildcats','School 1','OLD','NEW']);
  assert.equal(result.report.members,2);
  assert.throws(() => buildCatalog({...input,fbs:{...input.fbs,count:2}}),/membership-incomplete/);
  assert.throws(() => buildCatalog({...input,fcs:membership(['1'])}),/membership-overlap/);
  assert.throws(() => buildCatalog({...input,coreTeams:[meta('1','NEW')]}),/membership-missing-core/);
  assert.throws(() => buildCatalog({...input,coreTeams:[...input.coreTeams,meta('2','TWO')]}),/core-unexpected-or-duplicate/);
  assert.throws(() => buildCatalog({...input,bulkTeams:[]}),/bulk-incomplete/);
});
