import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = resolve(root, 'lib/football/domain/college-teams.generated.ts');
const reportPath = resolve(root, 'lib/football/domain/college-teams.coverage.json');
const overlayPath = resolve(root, 'scripts/college-team-alias-overrides.json');
const core = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';
const bulk = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=1000';

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function string(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function id(value) { return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null; }
function numeric(a, b) { return Number(a) - Number(b); }

export function parseMembership(input, season, group) {
  const data = record(input);
  if (!data || !Number.isInteger(data.count) || data.count < 1 || data.count > 1000 || data.pageCount !== 1 || data.pageIndex !== 1 || !Array.isArray(data.items) || data.items.length !== data.count) throw new Error(`membership-incomplete-${group}`);
  const ids = new Set();
  for (const item of data.items) {
    const ref = string(record(item)?.$ref);
    let url;
    try { url = new URL(ref); } catch { throw new Error(`membership-invalid-ref-${group}`); }
    const match = new RegExp(`^/v2/sports/football/leagues/college-football/seasons/${season}/teams/(\\d{1,20})$`).exec(url.pathname);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'sports.core.api.espn.com' || url.port || url.username || url.password || !match || ids.has(match[1])) throw new Error(`membership-invalid-ref-${group}`);
    ids.add(match[1]);
  }
  return ids;
}

function parseTeam(value) {
  const team = record(value);
  const teamId = id(team?.id);
  if (!teamId) throw new Error('catalog-invalid-team-id');
  const aliases = [team.displayName, team.location, team.shortDisplayName, team.abbreviation].map(string);
  if (aliases.some(alias => alias === null)) throw new Error(`catalog-missing-identity-${teamId}`);
  return { id:`espn:ncaaf:${teamId}`, aliases:[...new Set(aliases)] };
}

export function buildCatalog({ season, fbs, fcs, bulkTeams, coreTeams, overrides, expectedBulkCount }) {
  if (!Number.isInteger(season) || season < 2000 || season > 2100) throw new Error('invalid-season');
  const fbsIds = parseMembership(fbs, season, 80);
  const fcsIds = parseMembership(fcs, season, 81);
  for (const teamId of fbsIds) if (fcsIds.has(teamId)) throw new Error(`membership-overlap-${teamId}`);
  if (!Array.isArray(bulkTeams) || !Array.isArray(coreTeams) || !Array.isArray(overrides)) throw new Error('catalog-invalid-input');
  if (!Number.isInteger(expectedBulkCount) || expectedBulkCount < 1 || bulkTeams.length !== expectedBulkCount || bulkTeams.length >= 1000) throw new Error('bulk-incomplete');
  const teams = new Map();
  for (const item of bulkTeams) {
    const team = parseTeam(record(item)?.team);
    if (teams.has(team.id)) throw new Error(`catalog-duplicate-${team.id}`);
    teams.set(team.id, team);
  }
  const memberIds = new Set([...fbsIds, ...fcsIds].map(teamId => `espn:ncaaf:${teamId}`));
  const coreIds = new Set();
  for (const item of coreTeams) {
    const team = parseTeam(item);
    if (!memberIds.has(team.id) || coreIds.has(team.id)) throw new Error(`core-unexpected-or-duplicate-${team.id}`);
    coreIds.add(team.id);
    const directoryTeam = teams.get(team.id);
    teams.set(team.id, directoryTeam ? {id:team.id,aliases:[...new Set([...directoryTeam.aliases,...team.aliases])]} : team);
  }
  for (const memberId of memberIds) if (!coreIds.has(memberId)) throw new Error(`membership-missing-core-${memberId}`);
  const overridden = new Set();
  for (const entry of overrides) {
    const data = record(entry);
    const teamId = id(data?.espnId);
    const team = teamId ? teams.get(`espn:ncaaf:${teamId}`) : null;
    if (!team || overridden.has(team.id) || !Array.isArray(data.aliases) || !data.aliases.length || !Array.isArray(data.sourceUrls) || !data.sourceUrls.length || data.sourceUrls.some(url => !string(url)?.startsWith('https://'))) throw new Error(`invalid-override-${teamId}`);
    const aliases = data.aliases.map(string);
    if (aliases.some(alias => alias === null)) throw new Error(`invalid-override-${teamId}`);
    team.aliases = [...new Set([...team.aliases, ...aliases])];
    overridden.add(team.id);
  }
  const sorted = [...teams.values()].sort((a,b) => numeric(a.id.split(':')[2],b.id.split(':')[2]));
  const missing = [...memberIds].filter(memberId => !teams.has(memberId));
  if (missing.length) throw new Error(`membership-missing-${missing.join(',')}`);
  const report = { season, sources:{ bulk, fbs:`${core}/seasons/${season}/types/2/groups/80/teams?limit=1000`, fcs:`${core}/seasons/${season}/types/2/groups/81/teams?limit=1000`, coreTeam:`${core}/seasons/${season}/teams/{id}` }, fbs:fbsIds.size, fcs:fcsIds.size, members:memberIds.size, bulk:bulkTeams.length, core:coreIds.size, catalog:sorted.length, memberIds:[...memberIds].sort((a,b) => numeric(a.split(':')[2],b.split(':')[2])), missingMemberIds:missing };
  return { teams:sorted, report };
}

function render({ teams, report }) {
  return {
    catalog:`export const COLLEGE_TEAM_CATALOG_SEASON = ${report.season};\nexport const COLLEGE_TEAM_CATALOG: readonly { readonly id: string; readonly aliases: readonly string[] }[] = ${JSON.stringify(teams,null,2)};\n`,
    coverage:`${JSON.stringify(report,null,2)}\n`,
  };
}

async function json(url) {
  const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json','User-Agent':'SundayRoom/1.0'}});
  if (!response.ok) { await response.body?.cancel(); throw new Error(`catalog-http-${response.status}-${url}`); }
  return response.json();
}

async function boundedMap(values, concurrency, task) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({length:Math.min(concurrency,values.length)},async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await task(values[index]);
    }
  }));
  return output;
}

async function publish(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  try { await writeFile(temporary,contents); await rename(temporary,path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const seasonArg = args.find(arg => arg.startsWith('--season='));
  const countArg = args.find(arg => arg.startsWith('--bulk-count='));
  if (args.some(arg => arg !== '--check' && arg !== seasonArg && arg !== countArg)) throw new Error('usage: node scripts/generate-college-team-catalog.mjs [--season=YYYY] [--bulk-count=N] [--check]');
  const season = seasonArg ? Number(seasonArg.slice(9)) : 2026;
  if (!Number.isInteger(season) || season < 2000 || season > 2100) throw new Error('invalid-season');
  const expectedBulkCount = countArg ? Number(countArg.slice(13)) : season === 2026 ? 762 : null;
  const [fbs,fcs,directory,overrides] = await Promise.all([
    json(`${core}/seasons/${season}/types/2/groups/80/teams?limit=1000`),
    json(`${core}/seasons/${season}/types/2/groups/81/teams?limit=1000`),
    json(bulk),
    readFile(overlayPath,'utf8').then(JSON.parse),
  ]);
  const fbsIds = parseMembership(fbs,season,80), fcsIds = parseMembership(fcs,season,81);
  const members = [...new Set([...fbsIds,...fcsIds])].sort(numeric);
  const coreTeams = await boundedMap(members,6,teamId => json(`${core}/seasons/${season}/teams/${teamId}`));
  const bulkTeams = record(directory)?.sports?.[0]?.leagues?.[0]?.teams;
  const result = render(buildCatalog({season,fbs,fcs,bulkTeams,coreTeams,overrides,expectedBulkCount}));
  if (check) {
    const [catalog,coverage] = await Promise.all([readFile(catalogPath,'utf8'),readFile(reportPath,'utf8')]);
    if (catalog !== result.catalog || coverage !== result.coverage) throw new Error('catalog-out-of-date');
  } else {
    await publish(catalogPath,result.catalog);
    await publish(reportPath,result.coverage);
  }
  process.stdout.write(`${check ? 'Checked' : 'Generated'} ${members.length} FBS/FCS members and ${result.catalog.match(/"id":/g)?.length || 0} catalog teams for ${season}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
