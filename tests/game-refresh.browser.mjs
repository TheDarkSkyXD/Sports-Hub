import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';

const directory = await mkdtemp(join(tmpdir(), 'game-refresh-browser-'));
const at = Date.now();
const team = name => ({ name, short: name, abbreviation: name.slice(0, 3), color: '112233' });
const nfl = {
  id: '100', league: 'nfl', name: 'Nfl Away at Nfl Home', date: new Date(at + 3600000).toISOString(),
  home: team('Nfl Home'), away: team('Nfl Away'), status: 'pre', lifecycle: 'scheduled',
  detail: 'Scheduled', redzone: false, partitions: ['nfl'],
};
const college = {
  ...nfl, id: 'ncaaf-101', league: 'ncaaf', name: 'College Away at College Home',
  home: team('College Home'), away: team('College Away'), partitions: ['fbs'],
};
const gate = Promise.withResolvers();
const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
  sources: [],
  readSchedule: async source => {
    if (source.id === 'fbs') await gate.promise;
    return { games: source.id === 'nfl' ? [nfl] : source.id === 'fbs' ? [college] : [], league: source.league, at };
  },
});
const browser = await chromium.launch({
  channel: process.env.PLAYER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sunday-room:v1', JSON.stringify({
    slots: ['ncaaf-101', null, null, null], selected: ['ncaaf-101'],
  })));
  await page.route('**/api/games', async route => {
    const reply = await coordinator.command({ kind: 'board' });
    assert.equal(reply.kind, 'board');
    await route.fulfill({ json: reply.board });
  });
  await page.route('**/api/sources', async route => {
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    await route.fulfill({ json: reply.snapshot });
  });
  await page.goto(process.env.PLAYER_BASE_URL || 'http://127.0.0.1:3000');
  await page.waitForFunction(() => document.body.innerText.includes('Nfl Home'), {}, { timeout: 7000 });
  await page.waitForTimeout(16000);
  assert.equal(await page.getByText('Could not refresh game data. Retrying automatically.', { exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sunday-room:v1')).slots), ['ncaaf-101', null, null, null]);
  console.log('PASS: NFL games load while college is held beyond the old 15-second timeout; saved room survives.');
  gate.resolve();
  await page.waitForFunction(() => document.body.innerText.includes('College Home'), {}, { timeout: 7000 });
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sunday-room:v1')).slots), ['ncaaf-101', null, null, null]);
  assert.equal(await page.getByText('Could not refresh game data. Retrying automatically.', { exact: true }).count(), 0);
  console.log('PASS: College games appear when ready; automatic refresh completes without the warning.');
} finally {
  gate.resolve();
  await browser.close();
  await coordinator.stop();
  await rm(directory, { recursive: true, force: true });
}
