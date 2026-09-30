import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.POPUP_BASE_URL || 'http://127.0.0.1:3101';
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const release = (version) => ({
  version,
  pageUrl: `https://github.com/TheDarkSkyXD/Sports-Hub/releases/tag/v${version}`,
  notes: 'Fixes the installer.', publishedAt: 1767000000,
});
const statusFor = (state, commands = ['download']) => ({
  currentVersion: '1.0.2',
  source: { repo: 'TheDarkSkyXD/Sports-Hub', origin: 'packaged' },
  state,
  commands,
});

// The bridge must be installed as a function, not an interpolated string: the string form
// never reaches the page as a single expression, so the component found no bridge at all.
const install = (page, status) => page.addInitScript((s) => {
  const copy = () => JSON.parse(JSON.stringify(s));
  window.sundayDesktop = {
    get: async () => copy(), check: async () => copy(), download: async () => copy(),
    install: async () => copy(),
    subscribe: () => () => {},
  };
}, status);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await install(page, statusFor({ kind: 'available', release: release('1.0.3'), lastCheckedAt: 1 }));
await page.goto(base, { waitUntil: 'domcontentloaded' });
const popup = page.locator('.update-popup');
await popup.waitFor({ state: 'visible', timeout: 20000 });

const box = await popup.boundingBox();
assert.ok(box.x + box.width <= 1440, `popup must stay inside the right edge, x=${box.x}`);
assert.ok(box.x > 720, `popup must sit on the right half, x=${box.x}`);
assert.ok(box.y < 400, `popup must sit near the top, y=${box.y}`);
assert.match(await page.locator('.update-popup h2').innerText(), /1\.0\.3/, 'popup names the new version');
assert.match(await page.locator('.update-popup-versions').innerText(), /1\.0\.2/, 'popup names the installed version');
assert.ok(await page.locator('.update-popup-dismiss').isVisible(), 'popup has a dismiss control');
assert.ok(await page.getByRole('button', { name: /Download update/i }).isVisible(), 'popup offers the download action');
// The changelog belongs on the release page, not in a popup that opens on every launch.
assert.equal(await page.locator('.update-popup-notes').count(), 0, 'the popup must not print the changelog');
const releaseBody = await page.locator('.update-popup').innerText();
assert.ok(!/Restore Sportsurge|playback inside the custom player/i.test(releaseBody),
  'release note text must not leak into the popup');
assert.ok(await page.getByRole('button', { name: /What changed/i }).isVisible(), 'the changelog stays one click away');
assert.ok(await page.getByRole('button', { name: /^Dismiss$/ }).isVisible(), 'a visible Dismiss button, not just the X');
console.log(`popup renders top-right at x=${Math.round(box.x)} y=${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`);

await page.locator('.update-popup-dismiss').click();
await popup.waitFor({ state: 'detached', timeout: 5000 });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
assert.equal(await page.locator('.update-popup').count(), 0, 'a dismissed version must stay dismissed across a reload');
console.log('dismissal survives a reload');

await install(page, statusFor({ kind: 'available', release: release('1.0.4'), lastCheckedAt: 2 }));
await page.reload({ waitUntil: 'domcontentloaded' });
await popup.waitFor({ state: 'visible', timeout: 20000 });
assert.match(await page.locator('.update-popup h2').innerText(), /1\.0\.4/, 'a newer version re-opens the popup');
console.log('a newer release re-opens a dismissed popup');

for (const [label, state, commands] of [
  ['up to date', { kind: 'current', lastCheckedAt: 3 }, ['check']],
  ['never checked', { kind: 'idle', lastCheckedAt: null }, ['check']],
  ['unsupported', { kind: 'unsupported', reason: 'platform' }, []],
  ['checking', { kind: 'checking' }, []],
]) {
  const quiet = await context.newPage();
  await install(quiet, statusFor(state, commands));
  await quiet.goto(base, { waitUntil: 'domcontentloaded' });
  await quiet.waitForTimeout(2000);
  assert.equal(await quiet.locator('.update-popup').count(), 0, `${label} must not raise a popup`);
  await quiet.close();
}
console.log('up to date, never checked, unsupported and checking all stay quiet');

const settings = await context.newPage();
await install(settings, statusFor({ kind: 'current', lastCheckedAt: 4 }, ['check']));
await settings.goto(base, { waitUntil: 'domcontentloaded' });
await settings.waitForTimeout(2000);
await settings.getByRole('button', { name: /Room settings/i }).first().click();
await settings.locator('.update-panel').waitFor({ state: 'visible', timeout: 20000 });
assert.match(await settings.locator('.update-panel-current').innerText(), /latest version/i, 'settings says you are up to date');
const source = settings.locator('.update-panel-source .update-panel-link');
assert.match(await source.innerText(), /https:\/\/github\.com\/TheDarkSkyXD\/Sports-Hub\/releases/,
  'settings names the releases page it reads');
console.log('settings shows the up-to-date note and the release source address');

assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
await browser.close();
console.log('UpdatePopup verified in a real browser.');
