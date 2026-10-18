import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { SourcesSnapshotSchema } from '../lib/football/shared.ts';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.scratch', 'sources-all');
const profile = await mkdtemp(path.join(tmpdir(), 'sunday-room-sources-all-'));
const buildId = randomUUID();
const at = Date.now();
const leagues = ['nfl', 'ncaaf', 'nba', 'wnba', 'nhl', 'mlb', 'f1', 'nascar-cup', 'nascar-truck', 'motogp', 'motorsport', 'ufc', 'boxing', 'wwe', 'tna', 'aew', 'wrestling'];
const feeds = { kind: 'feeds', discovered: 1, mediaVerified: 0, decoded: 1, checking: 0 };
const link = (id, league) => ({ title: `${id} listing`, url: `https://example.invalid/${id}`, gameId: id, league, observedAt: at, freshness: 'fresh' });
const source = (id, name, supported, links) => ({
  id, name, catalogUrl: `https://example.invalid/${id}`, publicUrls: [], pending: false,
  leagues: supported, scopes: supported.map(league => ({ league, read: { kind: 'complete', checkedAt: at }, eventCount: 1, feeds })),
  collectionMode: 'compatible-feed-discovery', lastAttempt: { at, outcome: 'parsed' },
  listingCount: links.length, matchedGameCount: links.length, staleListingCount: 0, compatibleFeedCount: 1,
  freeChoiceCount: 1, workingChoiceCount: 1, unmatchedListingCount: 0, unmatchedReasons: [], links,
});
const game = (gameId, league, name, sourceIds, playable) => ({
  gameId, ...(league ? { league } : {}), name, date: new Date(at).toISOString(),
  sourceCount: sourceIds.length, uniqueFeedCount: playable ? 1 : 0, freeChoiceCount: 1,
  workingChoiceCount: playable ? 1 : 0, feeds, sharedRoutes: [],
  candidates: [{ id: `${gameId}-feed`, gameId, label: `${name} feed`, sourceIds, observedAt: at,
    availability: playable ? { kind: 'playable', checkedAt: at, proof: { kind: 'advancing-video', version: 1, startupMs: 500, observedMs: 3000, mediaAdvanceMs: 3000, presentedFrames: 90 } } : { kind: 'unknown' } }],
  sourceLinks: sourceIds.map(sourceId => ({ sourceId, ...link(gameId, league) })),
});
const catalogGame = (league, id, title) => ({
  id: `${league}:${id}`, league, gameId: id, title, url: `https://example.invalid/catalog/${id}`,
  matchReason: null, sourceStatus: 'live', detail: { kind: 'collected', at, providers: [] },
});
const mixed = SourcesSnapshotSchema.parse({
  at, revision: 1, windowStartAt: at - 60_000, lastDiscoveryAt: at, browserCollectorsAvailable: true,
  scheduleScopes: leagues.map(league => ({ league, read: { kind: 'complete', checkedAt: at } })),
  sources: [
    source('shared', 'Shared source', ['nfl', 'nba', 'wwe'], [link('401', 'nfl'), link('nba-402', 'nba'), link('wwe-403', 'wwe'), link('unknown-404', null), { ...link('unmatched', null), gameId: null }]),
    source('sportsurge-v2', 'Sportsurge V2', ['nfl', 'nba'], [link('401', 'nfl'), link('nba-402', 'nba')]),
    source('wrestling', 'Wrestling source', ['wwe'], [link('wwe-403', 'wwe')]),
  ],
  games: [
    game('401', 'nfl', 'NFL fixture', ['shared', 'sportsurge-v2'], true),
    game('nba-402', 'nba', 'NBA fixture', ['shared', 'sportsurge-v2'], false),
    game('wwe-403', 'wwe', 'WWE fixture', ['shared', 'wrestling'], true),
    game('unknown-404', null, 'Unclassified fixture', ['shared'], true),
  ],
  sportsurgeV2: { current: {
    runId: '00000000-0000-4000-8000-000000000001', startedAt: at - 1000, receivedAt: at, interrupted: false,
    state: { kind: 'partial', at, reason: 'timeout' }, categories: { nfl: { kind: 'collected', at }, ncaaf: { kind: 'collected', at }, nba: { kind: 'failed', at, reason: 'timeout' } },
    gameCount: 2, collectedDetails: 2, pendingDetails: 0, failedDetails: 0, providerRows: 0, rejectedProviders: 0,
    rejectedGames: [{ league: 'nba', title: 'NBA rejected listing', reason: 'invalid-detail-url' }], catalogIssues: [],
    games: [catalogGame('nfl', '401', 'NFL catalog event'), catalogGame('nba', 'nba-402', 'NBA catalog event')],
  }, lastComplete: null, previous: null },
  streameast: { current: null, lastComplete: null, previous: null },
});
let snapshot = mixed;
let desktop;
await mkdir(output, { recursive: true });
await mkdir(path.join(root, '.desktop-runtime', 'local-build-config'), { recursive: true });
await writeFile(path.join(root, '.desktop-runtime', 'local-build-config', `${buildId}.json`), JSON.stringify({ extends: '../../tsconfig.json', include: ['../../next-env.d.ts', '../../app/**/*.ts', '../../app/**/*.tsx', '../../components/**/*.tsx', '../../lib/**/*.ts'] }));

try {
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), '--dev', `--user-data-dir=${profile}`], cwd: root,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
      SUNDAY_ROOM_NEXT_DIST_DIR: `.desktop-runtime/local-builds/${buildId}` }, timeout: 90_000,
  });
  const deadline = Date.now() + 90_000;
  let page;
  while (!page && Date.now() < deadline) {
    page = desktop.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, 'The isolated Electron app must open');
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await desktop.context().route('**/api/games', route => route.fulfill({ json: {
    schemaVersion: 2, revision: 1, updatedAt: new Date(at).toISOString(), scheduleState: 'ready',
    aliases: {}, leagues: {}, games: [], finishedGameRetentionMinutes: 120,
  } }));
  await desktop.context().route('**/api/sources', route => route.fulfill({ json: snapshot }));
  await page.reload();
  const nativeWindow = await desktop.browserWindow(page);
  await nativeWindow.evaluate(window => { window.setContentSize(1500, 1100); window.showInactive(); });
  await nativeWindow.dispose();
  await page.getByRole('button', { name: 'Room settings' }).click();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  const inventory = page.locator('.source-inventory');
  await inventory.getByRole('tab', { name: 'NFL', exact: true }).waitFor();
  if (process.argv.includes('--before')) await page.screenshot({ path: path.join(output, 'before.png') });
  assert.equal(await inventory.getByRole('tab', { name: 'All', exact: true }).count(), 1, 'Sources must offer an All league tab');
  assert.equal(await inventory.getByRole('tab', { name: 'NFL', exact: true }).getAttribute('aria-selected'), 'true');
  await inventory.getByRole('tab', { name: 'NFL', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await inventory.locator('[role="tab"][aria-selected="true"]').filter({ hasText: /^All$/ }).waitFor();
  assert.equal(await inventory.getByRole('tab', { name: 'All', exact: true }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(await inventory.locator('.source-inventory-overview strong').allTextContents(), ['3', '4', '3']);
  assert.equal(await inventory.getByText('Shared source', { exact: true }).count(), 1);
  await inventory.getByRole('combobox').selectOption('attention');
  assert.equal(await inventory.getByText('Sportsurge V2', { exact: true }).count(), 1);
  assert.equal(await inventory.getByText('Partial collection', { exact: true }).count(), 1);
  await inventory.getByRole('combobox').selectOption('all');
  const collector = inventory.locator('.source-inventory-source-list > details').filter({ hasText: 'Sportsurge V2' });
  await collector.locator('summary').first().click();
  await collector.getByText('NFL catalog event', { exact: true }).waitFor();
  await collector.getByText('NBA catalog event', { exact: true }).waitFor();
  assert.equal(await collector.getByText('Retained All game links', { exact: true }).count(), 0);
  await collector.getByText('Rejected game links', { exact: true }).click();
  assert.match(await collector.innerText(), /NBA rejected listing/);
  await inventory.getByRole('button', { name: 'Games', exact: true }).click();
  assert.deepEqual(await inventory.locator('.source-inventory-game-list > details > summary strong').allTextContents(), ['NFL fixture', 'NBA fixture', 'WWE fixture', 'Unclassified fixture']);
  await inventory.getByRole('searchbox', { name: 'Find a listed game' }).fill('WWE');
  assert.equal(await inventory.locator('.source-inventory-game-list > details').count(), 1);
  await inventory.getByRole('tab', { name: 'NFL', exact: true }).click();
  assert.equal(await inventory.getByRole('searchbox', { name: 'Find a listed game' }).inputValue(), '');
  assert.deepEqual(await inventory.locator('.source-inventory-game-list > details > summary strong').allTextContents(), ['NFL fixture']);
  await inventory.getByRole('searchbox', { name: 'Find a listed game' }).fill('NFL');
  await inventory.getByRole('tab', { name: 'All', exact: true }).click();
  assert.equal(await inventory.getByRole('searchbox', { name: 'Find a listed game' }).inputValue(), 'WWE');
  await inventory.getByRole('searchbox', { name: 'Find a listed game' }).fill('');
  await inventory.getByRole('tablist', { name: 'League', exact: true }).evaluate(list => list.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(output, 'after.png') });
  snapshot = { ...mixed, games: [], sources: [], scheduleScopes: [{ league: 'nfl', read: { kind: 'complete', checkedAt: at } }] };
  await inventory.getByRole('button', { name: 'Reload status' }).click();
  await inventory.getByText(/schedule is incomplete\. No empty schedule has been confirmed/).waitFor();
  snapshot = { ...snapshot, scheduleScopes: leagues.map(league => ({ league, read: { kind: 'complete', checkedAt: at } })) };
  await inventory.getByRole('button', { name: 'Reload status' }).click();
  await inventory.getByText('No games or events today or tomorrow.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS. All displays each source and game once, shared feed totals, mixed catalogs, partial status, independent search, keyboard tabs, and truthful empty schedules.');
} finally {
  await desktop?.close();
  console.log(`Retained isolated profile ${profile}`);
  console.log(`Retained isolated Next build .desktop-runtime/local-builds/${buildId}`);
}
