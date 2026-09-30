import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.POPUP_BASE_URL || 'http://127.0.0.1:3101';
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });

const release = (version) => ({
  version,
  pageUrl: `https://github.com/TheDarkSkyXD/Sports-Hub/releases/tag/v${version}`,
  notes: 'Fixes the installer.', publishedAt: 1767000000,
});
const available = (version) => ({
  currentVersion: '1.0.2', source: { repo: 'TheDarkSkyXD/Sports-Hub', origin: 'packaged' },
  state: { kind: 'available', release: release(version), lastCheckedAt: 1 }, commands: ['check', 'download'],
});
// The popup presents one chained action, so a check rides the same button. Install is
// verified separately, since it is the only command that relaunches the app.

// The stub stands in for the main process, so the point of this test is narrower: does a
// click actually send the command across the bridge, and does the answer drive the UI?
const install = (page, status) => page.addInitScript((s) => {
  window.__called = [];
  const copy = () => JSON.parse(JSON.stringify(s));
  const wrap = (name) => async () => { window.__called.push(name); return copy(); };
  window.sundayDesktop = {
    get: wrap('get'), check: wrap('check'), download: wrap('download'),
    install: wrap('install'),
    subscribe: () => () => {},
  };
}, status);

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await install(page, available('1.0.3'));
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.locator('.update-popup').waitFor({ state: 'visible', timeout: 20000 });

await page.getByRole('button', { name: /Download update/i }).click();
await page.waitForTimeout(400);
const afterDownload = await page.evaluate(() => window.__called);
assert.ok(afterDownload.includes('download'), `the download click must reach the bridge, saw ${afterDownload.join(',')}`);
console.log('clicking Download update sends a download command across the bridge');

// "What changed" must reach the release page without navigating the app itself.
const popupUrl = page.url();
await page.getByRole('button', { name: /What changed/i }).click();
await page.waitForTimeout(1200);
const opened = context.pages().filter((p) => p !== page);
assert.ok(opened.length >= 1, 'the changelog opens the release page');
assert.match(opened[opened.length - 1].url(), /github\.com\/.*\/releases\/tag\//, 'and it is the release page');
console.log('What changed opens the release page for', opened[opened.length - 1].url().slice(0, 72));
for (const extra of opened) await extra.close();

// Dismiss must close the popup, and must not reach the bridge at all.
const callsBeforeDismiss = (await page.evaluate(() => window.__called)).length;
await page.getByRole('button', { name: /^Dismiss$/ }).click();
await page.locator('.update-popup').waitFor({ state: 'detached', timeout: 5000 });
const callsAfterDismiss = (await page.evaluate(() => window.__called)).length;
assert.equal(callsAfterDismiss, callsBeforeDismiss, 'dismissing must not send a command');
assert.equal(page.url(), popupUrl, 'the app itself never navigated');
console.log('Dismiss closes the popup without sending anything');

await browser.close();
console.log('Popup buttons verified against the bridge.');
