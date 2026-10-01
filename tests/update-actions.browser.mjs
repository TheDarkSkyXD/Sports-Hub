import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.POPUP_BASE_URL || 'http://127.0.0.1:3101';
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

const release = (version) => ({
  version,
  pageUrl: `https://github.com/TheDarkSkyXD/Sports-Hub/releases/tag/v${version}`,
  notes: 'A long changelog that must never appear in the popup.', publishedAt: 1767000000,
  installer: { name: `Sunday-Room-${version}-Setup-x64.exe`, url: 'https://example.test/a.exe', bytes: 119067581, sha256: null },
});
const statusFor = (state, commands = ['download'], editable = false) => ({
  currentVersion: '1.0.2',
  source: { url: 'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download', editable },
  preferences: { autoCheckEnabled: true, checkFrequency: 'daily' },
  state, commands,
});

const install = (page, status) => page.addInitScript((s) => {
  const copy = () => JSON.parse(JSON.stringify(s));
  window.sundayDesktop = {
    get: async () => copy(), check: async () => copy(), download: async () => copy(),
    install: async () => copy(),
    setSource: async () => copy(),
    subscribe: () => () => {},
  };
}, status);

// One button walks the whole chain: available -> download, ready -> install. A person
// never has to know which of those is currently applicable.
const advanceButton = async (label, state, commands) => {
  const probe = await context.newPage();
  await install(probe, statusFor(state, commands));
  await probe.goto(base, { waitUntil: 'domcontentloaded' });
  await probe.locator('.update-popup').waitFor({ state: 'visible', timeout: 20000 });
  const button = probe.locator('.update-popup-actions button').first();
  const text = (await button.innerText()).trim();
  assert.equal(text, label, `expected the primary action to read "${label}"`);
  console.log(`  ${state.kind.padEnd(11)} -> "${text}"`);
  await probe.close();
};

console.log('the chained update button:');
await advanceButton('Download update', { kind: 'available', release: release('1.0.3'), lastCheckedAt: 1 }, ['check', 'download']);
await advanceButton('Install and restart', { kind: 'ready', release: release('1.0.3'), verifiedAt: 1767000000 }, ['install']);
await advanceButton('Retry download', { kind: 'failed', reason: 'download', detail: 'The download did not finish.', retry: 'download', release: release('1.0.3') }, ['download']);
await advanceButton('Retry install', { kind: 'failed', reason: 'install', detail: 'The installer could not start.', retry: 'install', release: release('1.0.3') }, ['install']);
// A development build is offered check only, so the popup must not promise a download.
await advanceButton('Check updates', { kind: 'available', release: release('1.0.3'), lastCheckedAt: 1 }, ['check']);

// electron-updater cannot abort a transfer, so a download in flight has no action to
// offer. The popup must stay up showing progress, not disappear mid-transfer.
const inFlight = await context.newPage();
await install(inFlight, statusFor({ kind: 'downloading', release: release('1.0.3'), percent: 41 }, []));
await inFlight.goto(base, { waitUntil: 'domcontentloaded' });
await inFlight.locator('.update-popup').waitFor({ state: 'visible', timeout: 20000 });
assert.equal(await inFlight.locator('.update-popup-actions .button.primary').count(), 0,
  'there is no button that would do nothing');
assert.match(await inFlight.locator('.update-popup-progress').innerText(), /41%/, 'the progress is shown instead');
assert.ok(await inFlight.getByRole('button', { name: /^Dismiss$/ }).isVisible(), 'and it can still be dismissed');
await inFlight.close();
console.log('  a transfer in flight shows progress and offers nothing to press');

// The settings panel names the address it checks, and links to it. There is no field to
// edit: the feed is baked into the build, and an app that could be pointed at another
// repository would run whatever that repository published.
const settings = await context.newPage();
await install(settings, statusFor({ kind: 'current', lastCheckedAt: 4 }, ['check']));
await settings.goto(base, { waitUntil: 'domcontentloaded' });
await settings.waitForTimeout(2000);
await settings.getByRole('button', { name: /Room settings/i }).first().click();
await settings.locator('.update-panel').waitFor({ state: 'visible', timeout: 20000 });
const feed = settings.locator('.update-panel-source .update-panel-link');
assert.match(await feed.innerText(), /https:\/\/github\.com\/TheDarkSkyXD\/Sports-Hub\/releases$/,
  'the panel names the releases page a person can open, not the raw download path');
assert.match(await feed.getAttribute('href'), /^https:\/\/github\.com\/TheDarkSkyXD\/Sports-Hub\/releases$/);
// An installed app keeps its feed, so the field is shown read-only with nothing to save.
const field = settings.locator('#update-source-url');
assert.equal(await field.inputValue(), 'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download',
  'the field holds the feed URL, which is the address the updater actually polls');
assert.equal(await field.isEditable(), false, 'and an installed build cannot change it');
assert.equal(await settings.getByRole('button', { name: /Save source/i }).count(), 0, 'so nothing to save');
assert.match(await settings.locator('.update-panel-source').innerText(), /not signed/i,
  'and it says why, rather than looking broken');
assert.match(await settings.locator('.update-panel-source').innerText(), /checksum the published record carries/i,
  'and it says what the download check is actually worth');
console.log('the panel shows the feed it polls, and an installed build cannot change it');

// A development build may point at a fork, because it never installs anything. The stub
// reports itself editable, which is how the main process describes a packaged=false build.
const dev = await context.newPage();
await install(dev, statusFor({ kind: 'current', lastCheckedAt: 4 }, ['check'], true));
await dev.goto(base, { waitUntil: 'domcontentloaded' });
await dev.waitForTimeout(2000);
await dev.getByRole('button', { name: /Room settings/i }).first().click();
await dev.locator('.update-panel').waitFor({ state: 'visible', timeout: 20000 });
const devField = dev.locator('#update-source-url');
assert.equal(await devField.isEditable(), true, 'a development build can be pointed at a fork');
for (const [value, why] of [
  ['https://evil.test/owner/name/releases/latest/download', 'another host'],
  ['http://github.com/o/n/releases/latest/download', 'not https'],
  ['https://github.com/o/n/releases/latest', 'not the download path'],
  ['not a url at all', 'plain text'],
]) {
  await devField.fill(value);
  await dev.getByRole('button', { name: /Save source/i }).click();
  await dev.waitForTimeout(200);
  assert.match(await dev.locator('.update-panel-error').innerText(), /releases address/i,
    `${why} must be refused: ${value}`);
  assert.equal(await devField.inputValue(), value, 'the refused value stays put so it can be corrected');
}
await dev.close();
console.log('a development build can be pointed at a fork, and only at a GitHub releases URL');

// The panel keeps the same one-click path to the changelog, and never prints it inline.
assert.equal(await settings.locator('.update-panel-notes').count(), 0, 'the panel must not print the changelog either');

await browser.close();
console.log('\nUpdate actions verified in a real browser.');
