import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGameIdMap, remapRoomIds, remapRoomRecord } from '../lib/reconcile-room.ts';
import type { Game } from '../lib/sunday.ts';

const team = (name: string) => ({ name, short: name, abbreviation: name.slice(0, 3), color: '112233', score: '0' });
const game: Game = { id: '1', name: 'Away at Home', home: team('Home'), away: team('Away'), status: 'in', detail: 'Q1', redzone: false, date: '2026-09-20T17:00:00Z' };
const source = 'https://isportsurge.ws/watch/nfl/away-home/123';

test('current exact IDs remain stable regardless of optional source metadata', () => {
  const map = buildGameIdMap([game], [{ ...game, sourceUrl: source }, { ...game, id: '2' }]);
  assert.equal(map.get('1'), '1');
  assert.equal(map.get('2'), '2');
});

test('source-only games follow official IDs when the scoreboard recovers', () => {
  const map = buildGameIdMap([{ ...game, id: 'source-123', date: undefined, sourceUrl: `${source}#player` }], [{ ...game, sourceUrl: source }]);
  assert.equal(map.get('source-123'), '1');
  assert.deepEqual(remapRoomIds(['source-123', '1', 'missing'], map), ['1']);
});

test('same-day matchup fallback tolerates home-away order and kickoff corrections', () => {
  const next = { ...game, id: 'next', home: team('AWAY'), away: team('Home.'), date: '2026-09-20T18:00:00Z' };
  assert.equal(buildGameIdMap([game], [next]).get('1'), 'next');
});

test('matchup fallback never migrates to a later rematch or undated event', () => {
  assert.equal(buildGameIdMap([game], [{ ...game, id: 'later', date: '2026-10-20T17:00:00Z' }]).has('1'), false);
  assert.equal(buildGameIdMap([{ ...game, date: undefined }], [{ ...game, id: 'undated' }]).has('1'), false);
  assert.equal(buildGameIdMap([game], [{ ...game, id: 'invalid', date: 'not a date' }]).has('1'), false);
});

test('conflicting known dates reject reused source links', () => {
  const map = buildGameIdMap([{ ...game, sourceUrl: source }], [{ ...game, id: 'later', sourceUrl: source, date: '2026-10-20T17:00:00Z' }]);
  assert.equal(map.has('1'), false);
});

test('ambiguous matchups and source links are left unmapped', () => {
  assert.equal(buildGameIdMap([game], [{ ...game, id: 'a' }, { ...game, id: 'b' }]).has('1'), false);
  assert.equal(buildGameIdMap([{ ...game, sourceUrl: source }], [{ ...game, id: 'a', sourceUrl: source }, { ...game, id: 'b', sourceUrl: source }]).has('1'), false);
});

test('room remapping preserves selection order and removes unavailable games', () => {
  const map = new Map([['old-a', 'new-a'], ['old-b', 'new-b'], ['alias-a', 'new-a']]);
  assert.deepEqual(remapRoomIds(['old-b', 'missing', 'old-a', 'alias-a'], map), ['new-b', 'new-a']);
  assert.deepEqual(remapRoomIds([], map), []);
});

test('fresh sessions recover saved source IDs from validated current game links', () => {
  const map = buildGameIdMap([], [{ ...game, sourceUrl: source }]);
  assert.deepEqual(remapRoomIds(['source-123'], map), ['1']);
  assert.equal(buildGameIdMap([], [{ ...game, sourceUrl: 'https://untrusted.example/watch/nfl/away-home/123' }]).has('source-123'), false);
  assert.equal(buildGameIdMap([], [{ ...game, sourceUrl: source }, { ...game, id: '2', sourceUrl: source }]).has('source-123'), false);
});

test('source alias seeding does not override known conflicting dates or current exact IDs', () => {
  const old = { ...game, id: 'source-123', sourceUrl: source };
  const later = { ...game, sourceUrl: source, date: '2026-10-20T17:00:00Z' };
  assert.equal(buildGameIdMap([old], [later]).has('source-123'), false);
  assert.equal(buildGameIdMap([], [{ ...game, sourceUrl: source }, old]).get('source-123'), 'source-123');
});

test('feed and delay records migrate aliases, preserve archived keys, and prefer canonical values', () => {
  const map = new Map([['source-123', '1'], ['source-456', '2'], ['1', '1'], ['2', '2']]);
  const feeds = remapRoomRecord({ 'source-123': 'old feed', '1': 'current feed', archived: 'keep me', 'source-456': 'other feed' }, map);
  assert.deepEqual(feeds, { '1': 'current feed', '2': 'other feed', archived: 'keep me' });
  assert.deepEqual(remapRoomRecord({ 'source-123': 15, archived: 20 }, map), { '1': 15, archived: 20 });
});
