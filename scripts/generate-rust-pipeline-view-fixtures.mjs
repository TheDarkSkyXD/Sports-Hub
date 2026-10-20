import {readFileSync as readBaseline} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const baselineIndex=process.argv.indexOf('--baseline-root');
if(baselineIndex<0||!process.argv[baselineIndex+1])throw new Error('Pass --baseline-root with the original TypeScript repository snapshot.');
const baselineRoot=resolve(process.argv[baselineIndex+1]);
if(readBaseline(join(baselineRoot,'lib/football/domain/matching.ts'),'utf8').includes('createNativeMatcher'))
 throw new Error('Native results cannot replace the frozen TypeScript expectations.');
const baselineModule=relative=>import(pathToFileURL(join(baselineRoot,relative)).href);

import { writeFile } from 'node:fs/promises';

const { sourceInventory, roomSourceInventory, roomSources }=await baselineModule('lib/football/domain/source-inventory.ts');
const { sportsurgeObservation, sportsurgeEventCandidates, sportsurgeEvidence, catalogDecision, sameSportsurgeEvent }=await baselineModule('lib/football/domain/sportsurge-catalog.ts');
const { streameastObservation, streameastCandidates, streameastEvidence, streameastDecision, sameStreameastEvent }=await baselineModule('lib/football/domain/streameast-catalog.ts');

const at = Date.parse('2026-10-19T18:00:00Z');
const team = name => ({ name, short: name, abbreviation: name.slice(0, 3), color: '112233', score: '0' });
const game = { id: '100', league: 'nfl', name: 'Away at Home', date: new Date(at).toISOString(),
  home: team('Home'), away: team('Away'), status: 'in', lifecycle: 'live', detail: '', redzone: false, partitions: ['nfl'] };
const source = { id: 'fixture', url: 'https://fixture.example/list', family: 'fixture', leagues: ['nfl'] };
const observation = { id: 'fixture:100', sourceId: source.id, url: 'https://fixture.example/event',
  title: game.name, league: 'nfl', teams: ['Away', 'Home'], kickoff: at, rawTime: '', observedAt: at, parserVersion: 3 };
const candidate = { id: 'gooz:1', gameId: game.id, label: 'Fixture player', sourceIds: [source.id],
  observedAt: at, locator: { provider: 'gooz', playerId: '1' } };
const proof = { kind: 'advancing-video', version: 1, startupMs: 2000, observedMs: 2000, mediaAdvanceMs: 2000, presentedFrames: 3 };
const emptyCatalog = { current: null, lastComplete: null, previous: null };
const cases = [];
const add = (operation, input, expected) => cases.push({ operation, input, expected });
const availability = [{ kind: 'unknown' }, { kind: 'checking', progress: { kind: 'queued', since: at } },
  { kind: 'playable', checkedAt: at, proof }, { kind: 'unavailable', checkedAt: at, retryAt: at + 300000, reason: 'upstream' }];
for (const state of availability) for (const age of [0, 1800000, 1800001]) for (const fresh of [true, false]) {
  const input = { at: at + age, revision: 7, lastDiscoveryAt: at, browserCollectorsAvailable: true,
    sources: [source], observations: [observation], games: [game], candidates: [[game.id, [candidate]]],
    attempts: { fixture: { at, outcome: 'parsed', count: 1, nextEligibleAt: at + 1800000 } },
    sportsurgeCatalog: emptyCatalog, streameastCatalog: emptyCatalog, details: [], sourceEventBindings: [],
    freshGameIds: fresh ? [game.id] : [], availability: { [candidate.id]: state } };
  const hydrated = { ...input, candidates: new Map(input.candidates), freshGameIds: new Set(input.freshGameIds),
    availability: value => input.availability[value.id] };
  const full = sourceInventory(hydrated);
  add('sourceInventory', input, full);
  add('roomSourceInventory', input, roomSourceInventory(hydrated));
  add('roomSources', full, roomSources(full));
}
const surge = { id: 'nfl:1', url: 'https://v2.sportsurge.net/watch-1-nfl-away-vs-home/', league: 'nfl',
  title: game.name, teams: ['Away', 'Home'], kickoff: at, sourceStatus: 'live', advertisedLinkCount: 1,
  detail: { kind: 'collected', at, providers: [{ id: 'provider-1', label: 'Fixture provider', observedAt: at,
    destination: { kind: 'link', url: 'https://sportsupa.st/event/?id=away-vs-home-1&src=best&sno=1' } }] } };
const east = { id: 'nfl:1', url: 'https://v2.streameast.ga/nfl/away-vs-home/', league: 'nfl', title: game.name,
  teams: ['Away', 'Home'], kickoff: at, espnEventId: '100', detail: { kind: 'collected', at,
    servers: [{ id: '1', label: 'Server 1', url: 'https://v2.streameast.ga/nfl/away-vs-home/1',
      availability: { kind: 'free-channel', channelId: '1' } }] } };
add('sportsurgeObservation', [surge, at], sportsurgeObservation(surge, at));
add('sportsurgeEventCandidates', [surge, game.id], sportsurgeEventCandidates(surge, game.id));
add('sportsurgeEvidence', [surge, at], sportsurgeEvidence(surge, at));
add('sameSportsurgeEvent', [surge, surge], sameSportsurgeEvent(surge, surge));
add('streameastObservation', [east, at], streameastObservation(east, at));
add('streameastCandidates', [east, game.id], streameastCandidates(east, game.id));
add('streameastEvidence', [east], streameastEvidence(east));
add('sameStreameastEvent', [east, east], sameStreameastEvent(east, east));
for (const sequence of [0, 1]) {
  add('catalogDecision', [null, { sequence }], catalogDecision(null, { sequence }));
  add('streameastDecision', [null, { sequence }], streameastDecision(null, { sequence }));
}
await writeFile(new URL('../tests/fixtures/rust-pipeline-views.json', import.meta.url), JSON.stringify({ cases }, null, 2) + '\n');
console.log(`Saved ${cases.length} pipeline view cases.`);
