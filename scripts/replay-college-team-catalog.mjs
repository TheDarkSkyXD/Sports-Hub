import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { matchObservation, mergeSchedulePartitions } from '../lib/football/domain/matching.ts';
import { GameSchema, ObservationSchema } from '../lib/football/shared.ts';

const args = process.argv.slice(2);
const snapshotPath = args.find(arg => arg.startsWith('--snapshot='))?.slice(11);
const databasePath = args.find(arg => arg.startsWith('--database='))?.slice(11) || join(process.env.SUNDAY_ROOM_DATA_DIR || join(process.cwd(),'.desktop-runtime'),'football.sqlite');
const outputPath = args.find(arg => arg.startsWith('--output='))?.slice(9);
const capturePath = args.find(arg => arg.startsWith('--capture='))?.slice(10);
if (snapshotPath && capturePath || args.some(arg => !arg.startsWith('--snapshot=') && !arg.startsWith('--database=') && !arg.startsWith('--output=') && !arg.startsWith('--capture='))) throw new Error('usage: node --experimental-strip-types scripts/replay-college-team-catalog.mjs [--snapshot=PATH | --database=PATH] [--capture=PATH] [--output=PATH]');

let snapshot;
if (snapshotPath) snapshot = JSON.parse(await readFile(snapshotPath,'utf8'));
else {
  const db = new DatabaseSync(databasePath,{readOnly:true});
  try {
    const partitions = db.prepare('SELECT payload FROM partitions').all().map(row => JSON.parse(row.payload).games.map(value => GameSchema.parse(value)));
    const games = mergeSchedulePartitions(partitions);
    const observations = db.prepare('SELECT payload FROM observations').all().map(row => JSON.parse(row.payload));
    snapshot = {now:Date.now(),games,observations};
  } finally { db.close(); }
}
if (!Number.isFinite(snapshot.now) || !Array.isArray(snapshot.games) || !Array.isArray(snapshot.observations) || snapshot.baseline && (!Array.isArray(snapshot.baseline.result) || snapshot.observations.length !== snapshot.baseline.result.length)) throw new Error('invalid-replay-snapshot');
snapshot.games = snapshot.games.map(value => GameSchema.parse(value));
snapshot.observations = snapshot.observations.map(value => ObservationSchema.parse(value));

function matchFields(value) {
  if (value?.kind === 'matched' && typeof value.gameId === 'string') return {kind:'matched',gameId:value.gameId};
  if (value?.kind === 'unmatched' && typeof value.reason === 'string' && Array.isArray(value.possibleGameIds) && value.possibleGameIds.every(id => typeof id === 'string')) return {kind:'unmatched',reason:value.reason,possibleGameIds:value.possibleGameIds};
  throw new Error('invalid-baseline-match');
}

const baseline = snapshot.baseline ? new Map(snapshot.baseline.result.map(result => {
  if (typeof result?.id !== 'string') throw new Error('invalid-baseline-id');
  return [result.id,matchFields(result)];
})) : null;
const coverage = JSON.parse(await readFile(new URL('../lib/football/domain/college-teams.coverage.json',import.meta.url),'utf8'));
const counts = {};
const retained = [], lost = [], changed = [], newlyNameEligible = [], newlyDatedMatches = [];
const unresolvedNames = new Map();
for (const observation of snapshot.observations) {
  const before = baseline?.get(observation.id);
  if (baseline && !before) throw new Error(`missing-baseline-${observation.id}`);
  const after = matchObservation(observation,snapshot.games,snapshot.now);
  const category = after.kind === 'matched' ? 'matched' : after.reason;
  counts[category] = (counts[category] || 0) + 1;
  const row = {id:observation.id,sourceId:observation.sourceId,teams:observation.teams,before,after};
  if (before?.kind === 'matched') {
    if (after.kind !== 'matched') lost.push(row);
    else if (after.gameId !== before.gameId) changed.push(row);
    else retained.push(observation.id);
  }
  const eligible = result => result.kind === 'matched' || Array.isArray(result.possibleGameIds) && result.possibleGameIds.length > 0;
  if (before && !eligible(before) && after.kind === 'unmatched' && after.possibleGameIds.length > 0) newlyNameEligible.push(row);
  if (before && before.kind !== 'matched' && after.kind === 'matched') newlyDatedMatches.push(row);
  if (after.kind === 'unmatched' && after.reason === 'unknown-teams' && Array.isArray(observation.teams)) {
    const key = JSON.stringify([observation.sourceId,observation.teams]);
    const item = unresolvedNames.get(key) || {sourceId:observation.sourceId,teams:observation.teams,count:0};
    item.count++;
    unresolvedNames.set(key,item);
  }
}
if (capturePath) {
  const games = snapshot.games.map(game => ({...game,sourceUrl:undefined,sourceUrls:undefined,home:{...game.home,logo:undefined},away:{...game.away,logo:undefined}}));
  const observations = snapshot.observations.map(({id,sourceId,league,teams,kickoff,observedAt,parserVersion}) => ({id,sourceId,url:'https://example.invalid/event',title:'Captured observation',league,teams,kickoff,rawTime:'',observedAt,parserVersion}));
  const result = snapshot.observations.map(observation => ({id:observation.id,...matchObservation(observation,snapshot.games,snapshot.now)}));
  await writeFile(capturePath,`${JSON.stringify({now:snapshot.now,games,observations,baseline:{result}},null,2)}\n`);
}
const report = {source:snapshotPath || databasePath,evaluatedAt:new Date(snapshot.now).toISOString(),catalog:{season:coverage.season,members:coverage.members,teams:coverage.catalog,missingMemberIds:coverage.missingMemberIds},observations:snapshot.observations.length,catalogMatches:counts.matched || 0,counts,...(baseline ? {retainedMatches:retained.length,lostMatches:lost,changedMatches:changed,newlyNameEligible,newlyDatedMatches} : {}),unresolvedNames:[...unresolvedNames.values()].sort((a,b) => b.count-a.count)};
if (outputPath) await writeFile(outputPath,`${JSON.stringify(report,null,2)}\n`);
process.stdout.write(`${JSON.stringify({source:report.source,catalog:report.catalog,observations:report.observations,catalogMatches:report.catalogMatches,...(baseline ? {retainedMatches:retained.length,lostMatches:lost.length,changedMatches:changed.length,newlyNameEligible:newlyNameEligible.length,newlyDatedMatches:newlyDatedMatches.length} : {}),unresolvedNames:unresolvedNames.size},null,2)}\n`);
