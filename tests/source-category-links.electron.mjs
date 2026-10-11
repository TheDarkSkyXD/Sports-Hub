import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';
import { SOURCE_REGISTRY } from '../lib/football/source-registry.ts';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, '.scratch', 'source-category-links');
const profile = await mkdtemp(path.join(tmpdir(), 'sunday-room-category-links-'));
const buildId = randomUUID();
const at = Date.now();
const snapshot = sourceInventory({
  at, revision: 1, lastDiscoveryAt: null, browserCollectorsAvailable: true,
  sources: SOURCE_REGISTRY, observations: [], games: [], candidates: new Map(), attempts: {},
  sportsurgeCatalog: { current: null, lastComplete: null, previous: null },
  streameastCatalog: { current: null, lastComplete: null, previous: null },
});
await mkdir(output, { recursive: true });
await mkdir(path.join(root, '.desktop-runtime', 'local-build-config'), { recursive: true });
await writeFile(path.join(root, '.desktop-runtime', 'local-build-config', `${buildId}.json`), JSON.stringify({
  extends: '../../tsconfig.json',
  include: ['../../next-env.d.ts', '../../app/**/*.ts', '../../app/**/*.tsx', '../../components/**/*.tsx', '../../lib/**/*.ts'],
}));

let desktop;
try {
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [path.join(root, 'desktop/main.cjs'), '--dev', `--user-data-dir=${profile}`], cwd: root,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
      SUNDAY_ROOM_NEXT_DIST_DIR: `.desktop-runtime/local-builds/${buildId}`,
    }, timeout: 90_000,
  });
  const deadline = Date.now() + 90_000;
  let page;
  while (!page && Date.now() < deadline) {
    page = desktop.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, 'The local Electron app must open');
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await desktop.context().route('**/api/sources', route => route.fulfill({ json: snapshot }));
  await page.reload();
  const window = await desktop.browserWindow(page);
  await window.evaluate(native => { native.setContentSize(1500, 1100); native.showInactive(); });
  await window.dispose();
  await page.getByRole('button', { name: 'Room settings' }).click();
  await page.getByRole('tab', { name: 'Sources', exact: true }).click();
  const inventory = page.locator('.source-inventory');
  await inventory.getByRole('tab', { name: 'NFL', exact: true }).click();
  const sportsfeed = inventory.locator('.source-inventory-source-list > details').filter({ hasText: 'SportsFeed24' });
  await sportsfeed.locator('summary').first().click();
  await page.screenshot({ path: path.join(output, process.argv.includes('--before') ? 'before.png' : 'after-nfl.png') });
  const nflLinks = await sportsfeed.locator('.source-inventory-public-links a').evaluateAll(links => links.map(link => link.href));
  assert.equal(nflLinks[0], 'https://sportsfeed24.st/streams/nfl', 'NFL must open the public NFL listings');
  assert.equal(nflLinks.some(url => url.includes('bestfreestreaming.app')), false);
  assert.equal(nflLinks.some(url => url.endsWith('/streams/nba')), false);
  await inventory.getByRole('tab', { name: 'NHL', exact: true }).click();
  if (!(await sportsfeed.locator('summary').first().evaluate(summary => summary.parentElement.open))) {
    await sportsfeed.locator('summary').first().click();
  }
  assert.equal(await sportsfeed.locator('.source-inventory-public-links a').first().getAttribute('href'), 'https://sportsfeed24.st/streams/nhl');
  for (const [league, url] of [
    ['NBA', 'https://sportsfeed24.st/streams/nba'],
    ['F1', 'https://sportsfeed24.st/streams/F1'],
    ['NASCAR Cup', 'https://sportsfeed24.st/streams/F1'],
    ['MotoGP', 'https://sportsfeed24.st/streams/MOTOGP'],
    ['UFC', 'https://sportsfeed24.st/streams/mma'],
    ['Boxing', 'https://sportsfeed24.st/streams/Boxing'],
  ]) {
    await inventory.getByRole('tab', { name: league, exact: true }).click();
    if (!(await sportsfeed.locator('summary').first().evaluate(summary => summary.parentElement.open))) {
      await sportsfeed.locator('summary').first().click();
    }
    assert.equal(await sportsfeed.locator('.source-inventory-public-links a').first().getAttribute('href'), url, league);
  }
  await inventory.getByRole('tab', { name: 'NBA', exact: true }).click();
  const ppv = inventory.locator('.source-inventory-source-list > details').filter({ has: page.getByText('PPV', { exact: true }) });
  await ppv.locator('summary').first().click();
  const ppvLinks = await ppv.locator('.source-inventory-public-links a').evaluateAll(links => links.map(link => link.href));
  assert.equal(ppvLinks[0], 'https://ppv.st/#37');
  assert.equal(ppvLinks.some(url => url.endsWith('#26')), false, 'Basketball must not link to football');
  assert.deepEqual(errors, []);
  console.log('PASS Electron source links use the selected category and hide collection APIs.');
} finally {
  await desktop?.close();
}
