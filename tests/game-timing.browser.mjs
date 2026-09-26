import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = process.env.TIMING_BASE_URL || 'http://127.0.0.1:3100';
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const team = (name, abbreviation) => ({ name, short: name, abbreviation, color: '445566', score: null });
const makeGame = (id, away, home, status, detail, date) => ({
  id, league: 'nfl', name: `${away.name} at ${home.name}`, away, home, status, detail, date, redzone: false,
});
const games = [
  makeGame('1', team('Pre Away', 'PRA'), team('Pre Home', 'PRH'), 'pre', 'Sat TBD', '2026-09-27T00:00Z'),
  makeGame('2', team('Unknown Away', 'UNA'), team('Unknown Home', 'UNH'), 'unknown', 'Schedule unavailable'),
  makeGame('3', team('Bad Away', 'BDA'), team('Bad Home', 'BDH'), 'pre', 'Delayed', 'tomorrow'),
  makeGame('4', team('Live Away', 'LVA'), team('Live Home', 'LVH'), 'in', 'Q2', '2026-09-26T20:00Z'),
];
const board = () => ({ games, updatedAt: '2026-09-26T23:59:57Z', leagues: {
  nfl: { week: 4, scoresAt: '2026-09-26T23:59:57Z', sourceAt: null, errors: [] },
  ncaaf: { scoresAt: null, sourceAt: null, errors: [] },
} });

async function timingFor(page, parent, text) {
  const card = page.locator(parent).filter({ hasText: text }).first();
  await card.waitFor();
  return card.locator('.game-timing');
}

async function within(page, parent, text) {
  const card = page.locator(parent).filter({ hasText: text }).first();
  const timing = card.locator('.game-timing');
  const outer = await card.boundingBox();
  const inner = await timing.boundingBox();
  assert.ok(outer && inner, `${parent} timing is visible`);
  assert.ok(inner.x >= outer.x - 1 && inner.x + inner.width <= outer.x + outer.width + 1, `${parent} timing fits horizontally`);
  assert.ok(inner.y >= outer.y - 1 && inner.y + inner.height <= outer.y + outer.height + 1, `${parent} timing fits vertically`);
}

try {
  await mkdir('work/game-start-countdown', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'America/Chicago' });
  const warnings = [];
  page.on('console', message => { if (/hydration|server rendered html/i.test(message.text())) warnings.push(message.text()); });
  page.on('pageerror', error => warnings.push(error.message));
  await page.clock.install({ time: new Date('2026-09-26T23:59:57Z') });
  await page.clock.pauseAt(new Date('2026-09-26T23:59:57Z'));
  await page.route('**/api/games', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board()) }));
  await page.goto(origin);
  const surfaces = ['.mini-game', '.game-tile', '.center-game'];
  for (const surface of surfaces) {
    const timing = await timingFor(page, surface, 'PRA');
    await timing.getByText('Kickoff in 00:00:03').waitFor();
    assert.equal(await timing.locator('span').innerText(), 'Sat, Sep 26, 7:00 PM');
    assert.match(await page.locator(surface).filter({ hasText: 'PRA' }).first().innerText(), /Sat TBD/);
    await within(page, surface, 'PRA');
  }
  assert.equal(await (await timingFor(page, '.mini-game', 'BDA')).innerText(), 'Start time unavailable');
  assert.equal(await (await timingFor(page, '.mini-game', 'UNA')).innerText(), 'Start time unavailable');
  assert.doesNotMatch(await (await timingFor(page, '.mini-game', 'LVA')).innerText(), /Kickoff in|Awaiting kickoff/);
  await page.screenshot({ path: 'work/game-start-countdown/desktop-room.png', fullPage: true });

  await page.clock.runFor(1000);
  for (const surface of surfaces) assert.match(await (await timingFor(page, surface, 'PRA')).innerText(), /Kickoff in 00:00:02/);
  await page.clock.runFor(2000);
  for (const surface of surfaces) assert.match(await (await timingFor(page, surface, 'PRA')).innerText(), /Awaiting kickoff/);

  games[0] = { ...games[0], status: 'in', detail: 'Q1' };
  await page.getByRole('button', { name: 'Refresh game data' }).click();
  for (const surface of surfaces) {
    const card = page.locator(surface).filter({ hasText: 'PRA' }).first();
    await card.getByText('Q1').waitFor();
    assert.doesNotMatch(await card.locator('.game-timing').innerText(), /Kickoff in|Awaiting kickoff/);
  }

  games[0] = { ...games[0], status: 'pre', detail: 'Sun TBD', date: '2026-09-28T00:00Z' };
  await page.getByRole('button', { name: 'Refresh game data' }).click();
  await page.getByRole('button', { name: 'Game schedule' }).click();
  const scheduleTiming = await timingFor(page, '.schedule-card', 'PRA');
  assert.equal(await scheduleTiming.locator('span').innerText(), 'Sun, Sep 27, 7:00 PM');
  assert.match(await scheduleTiming.innerText(), /Kickoff in 1d 00:00:00/);
  await within(page, '.schedule-card', 'PRA');
  await page.screenshot({ path: 'work/game-start-countdown/desktop-schedule.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await within(page, '.mini-game', 'PRA');
  await within(page, '.schedule-card', 'PRA');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: 'work/game-start-countdown/mobile-schedule.png', fullPage: true });
  await page.getByRole('button', { name: 'Watch room' }).click();
  for (const surface of surfaces) await within(page, surface, 'PRA');
  assert.match(await (await timingFor(page, '.game-tile', 'PRA')).innerText(), /Kickoff in 1d 00:00:00/);
  await page.screenshot({ path: 'work/game-start-countdown/mobile-room.png', fullPage: true });
  await page.getByRole('button', { name: 'Focus view' }).click();
  await within(page, '.game-tile', 'PRA');
  await page.screenshot({ path: 'work/game-start-countdown/mobile-focus.png', fullPage: true });
  assert.deepEqual(warnings, []);
  await page.close();
} finally {
  await browser.close();
}
