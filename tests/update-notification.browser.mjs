import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.POPUP_BASE_URL || 'http://127.0.0.1:3101';
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const status = (state, commands = ['check']) => ({
  currentVersion: '1.0.2',
  source: { url: 'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download', editable: false },
  preferences: { autoCheckEnabled: true, checkFrequency: 'daily' },
  state,
  commands,
});

/**
 * The question this answers: does an update the user never asked about reach them?
 *
 * Every other browser test injects the status the popup reads on its first paint. That
 * skips the actual path an automatic check takes, which is a push over `subscribe` while
 * the popup is already mounted and showing "up to date". If that link were broken, the
 * popup would work when you pressed the button and never appear on its own — which is the
 * difference between an updater people find and one they don't.
 */
const page = await context.newPage();
await page.addInitScript((initial) => {
  let listener = null;
  const emit = (state, commands) => listener?.(JSON.parse(JSON.stringify({
    currentVersion: '1.0.2',
    source: { url: 'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download', editable: false },
    state, commands,
  })));
  window.sundayDesktop = {
    get: async () => initial,
    check: async () => initial,
    download: async () => initial,
    install: async () => initial,
    setSource: async () => initial,
    // No push yet: the app is up to date when it opens.
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
  };
  window.__releaseFound = (version) => emit(
    { kind: 'available', release: {
      version,
      pageUrl: `https://github.com/TheDarkSkyXD/Sports-Hub/releases/tag/v${version}`,
      notes: 'Restore the Sportsurge collection.',
      publishedAt: 1767000000,
    }, lastCheckedAt: Date.now() },
    ['check', 'download'],
  );
}, status({ kind: 'current', lastCheckedAt: Date.now() }));

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
assert.equal(await page.locator('.update-popup').count(), 0, 'nothing is shown when the app is up to date');

// The automatic check lands, without anyone pressing anything.
await page.evaluate(() => window.__releaseFound('1.0.3'));
await page.locator('.update-popup').waitFor({ state: 'visible', timeout: 20000 });

assert.match(await page.locator('.update-popup h2').innerText(), /1\.0\.3/, 'the pushed release is shown');
assert.match(await page.locator('.update-popup-versions').innerText(), /1\.0\.2/, 'and the version they are on');
assert.ok(await page.getByRole('button', { name: /Download update/i }).isVisible(), 'the download action is offered');
const box = await page.locator('.update-popup').boundingBox();
assert.ok(box.x > 720 && box.y < 400, `and it is the top-right popup, not somewhere else (${box.x}, ${box.y})`);
console.log('a release found by the automatic check reaches the popup with no press');

// And a press is never required to see it: the popup must not need a settings panel open.
assert.equal(await page.locator('[role="dialog"]').count(), 0, 'this happened with settings closed');
console.log('and it appears without the settings panel being open');

// Once dismissed, it stays dismissed for that version but a newer one still interrupts.
await page.getByRole('button', { name: /^Dismiss$/ }).click();
await page.locator('.update-popup').waitFor({ state: 'detached', timeout: 5000 });
await page.evaluate(() => window.__releaseFound('1.0.3'));
await page.waitForTimeout(1200);
assert.equal(await page.locator('.update-popup').count(), 0, 'the same version does not come back');

await page.evaluate(() => window.__releaseFound('1.0.4'));
await page.locator('.update-popup').waitFor({ state: 'visible', timeout: 20000 });
assert.match(await page.locator('.update-popup h2').innerText(), /1\.0\.4/, 'but a newer version does');
console.log('dismissal holds for one version, and a newer one interrupts again');

await browser.close();
console.log('\nAn unasked-for release reaches the user.');