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
const statusFor = (state, commands = ['download'], editable = true) => ({
  currentVersion: '1.0.2',
  source: { repo: 'TheDarkSkyXD/Sports-Hub', origin: 'packaged', editable },
  state, commands,
});

const install = (page, status) => page.addInitScript((s) => {
  const copy = () => JSON.parse(JSON.stringify(s));
  window.sundayDesktop = {
    get: async () => copy(), check: async () => copy(), download: async () => copy(),
    cancel: async () => copy(), install: async () => copy(), setSource: async () => copy(),
    subscribe: () => () => {},
  };
}, status);

// One button walks the whole chain: available -> download, ready -> install, downloading ->
// cancel. A person never has to know which of those is currently applicable.
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
await advanceButton('Install and restart', { kind: 'ready', release: release('1.0.3'), bytes: 119067581, verifiedAt: 1767000000 }, ['install']);
await advanceButton('Cancel download', { kind: 'downloading', release: release('1.0.3'), received: 41943040, total: 119067581 }, ['cancel']);
await advanceButton('Retry download', { kind: 'failed', reason: 'download', detail: 'The download did not finish.', retry: 'download', release: release('1.0.3') }, ['download']);
// A development build is offered check only, so the popup must not promise a download.
await advanceButton('Check for updates', { kind: 'available', release: release('1.0.3'), lastCheckedAt: 1 }, ['check']);

// The settings panel must name the releases page, and link to it.
const settings = await context.newPage();
await install(settings, statusFor({ kind: 'current', lastCheckedAt: 4 }, ['check']));
await settings.goto(base, { waitUntil: 'domcontentloaded' });
await settings.waitForTimeout(2000);
await settings.getByRole('button', { name: /Room settings/i }).first().click();
await settings.locator('.update-panel').waitFor({ state: 'visible', timeout: 20000 });
// The field is the only place the address appears; a duplicate link under it was noise.
assert.equal(await settings.locator('.update-panel-source-link').count(), 0, 'no second link below the field');
assert.equal(await settings.locator('#update-source-repo').inputValue(),
  'https://github.com/TheDarkSkyXD/Sports-Hub/releases',
  'the field holds the releases URL a person can find and paste');
// Saving a pasted releases URL must store the slug and clear the field to the canonical URL.
await settings.locator('#update-source-repo').fill('https://github.com/TheDarkSkyXD/Sports-Hub/releases/tag/v9.9.9');
await settings.getByRole('button', { name: /Save source/i }).click();
await settings.waitForTimeout(600);
assert.equal(await settings.locator('.update-panel-notice').innerText(), 'Now checking TheDarkSkyXD/Sports-Hub.',
  'a pasted URL resolves to the slug it names');
assert.equal(await settings.locator('#update-source-repo').inputValue(),
  'https://github.com/TheDarkSkyXD/Sports-Hub/releases', 'and the field returns to the canonical URL');

// Anything with no releases address to direct to has to be refused, and the source has to
// survive the refusal untouched.
for (const [value, why] of [
  ['TheDarkSkyXD/Sports-Hub', 'a bare slug names no page'],
  ['github.com/TheDarkSkyXD/Sports-Hub/releases', 'no scheme'],
  ['https://evil.test/owner/name/releases', 'another host'],
  ['https://github.com/owner/name/tree/main', 'a page that is not releases'],
  ['not a url at all', 'plain text'],
]) {
  await settings.locator('#update-source-repo').fill(value);
  await settings.getByRole('button', { name: /Save source/i }).click();
  await settings.waitForTimeout(250);
  const error = await settings.locator('.update-panel-error').count();
  assert.equal(error, 1, `${why} must be refused: ${value}`);
  assert.match(await settings.locator('.update-panel-error').innerText(), /releases address/i,
    `the error names what is wanted for: ${value}`);
  assert.equal(await settings.locator('#update-source-repo').inputValue(), value,
    'the refused value stays put so it can be corrected');
  assert.equal((await settings.locator('.update-panel-versions').first().innerText()).trim(),
    'Installed 1.0.2 · Latest 1.0.2', `a refused save must not change the source: ${why}`);
}
assert.equal(await settings.locator('.update-panel-notice').count(), 0, 'a refusal is an error, not a notice');
console.log('the source field refuses anything with no releases address, and the save button is coloured');

// The save button has to read as the action it performs.
const save = settings.getByRole('button', { name: /Save source/i });
const background = await save.evaluate((node) => getComputedStyle(node).backgroundColor);
assert.notEqual(background, 'rgba(0, 0, 0, 0)', 'the save button must not be transparent');
assert.match(await save.getAttribute('class'), /\bprimary\b/, 'and it is the primary button');
console.log('the source field round-trips a URL, refuses one that is not, and saves in colour');

// An installed app is pinned: the address is shown, but it cannot be changed, and there
// is no control that could try.
const installed = await context.newPage();
await install(installed, statusFor({ kind: 'current', lastCheckedAt: 4 }, ['check'], false));
await installed.goto(base, { waitUntil: 'domcontentloaded' });
await installed.waitForTimeout(2000);
await installed.getByRole('button', { name: /Room settings/i }).first().click();
await installed.locator('.update-panel').waitFor({ state: 'visible', timeout: 20000 });
const pinned = installed.locator('#update-source-repo');
assert.equal(await pinned.inputValue(), 'https://github.com/TheDarkSkyXD/Sports-Hub/releases',
  'an installed app still shows the address it uses');
assert.equal(await pinned.isEditable(), false, 'but it cannot be edited');
assert.equal(await installed.getByRole('button', { name: /Save source/i }).count(), 0,
  'and there is no control that could try');
assert.match(await installed.locator('.update-panel-source').innerText(), /installed app checks this address only/i,
  'and it says why, rather than looking broken');
await installed.close();
console.log('an installed app shows its source but cannot change it, and says why');
// The panel keeps the same one-click path to the changelog.
assert.equal(await settings.locator('.update-panel-notes').count(), 0, 'the panel must not print the changelog either');

await browser.close();
console.log('\nUpdate actions verified in a real browser.');
