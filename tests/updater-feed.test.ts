import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// electron-updater reads its feed from `dev-app-update.yml` next to the app when the app
// is not packaged, and from the `app-update.yml` that electron-builder bakes in when it
// is. `desktop/main.cjs` writes the first on every development launch, so the two must
// agree, or a development check reads a different address than an installed one.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a development build is given a feed the library will actually read', () => {
  // `isUpdaterActive` is false for an unpackaged app unless `forceDevUpdateConfig` is set.
  // Miss it and every check in development silently does nothing, which looks like
  // "up to date" rather than an error.
  const main = readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  assert.ok(main.includes('forceDevUpdateConfig'),
    'without forceDevUpdateConfig the library skips every check in a development build');
  assert.ok(main.includes('setFeedURL'),
    'the feed is handed to the library at runtime rather than baked into app-update.yml');
  assert.ok(main.includes("provider:'generic'"),
    'a generic provider pointed at a releases URL, which is what the library resolves latest.yml against');
  assert.ok(main.includes('SUNDAY_ROOM_UPDATE_SOURCE'), 'a development build must be able to point at a fork');
});

test('the feed is a GitHub releases URL in every place it is written', () => {
  const engine = readFileSync(path.join(root, 'desktop', 'update.cjs'), 'utf8');
  const feed = /const defaultUpdateFeedUrl = '([^']+)'/.exec(engine)?.[1];
  assert.equal(feed, 'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download',
    'one feed address, declared once in the engine');
  const lib = readFileSync(path.join(root, 'lib', 'desktop-update.ts'), 'utf8');
  assert.ok(lib.includes(feed), 'the renderer copies it rather than spelling it again');
  // The pattern is the trust boundary: the generic provider resolves latest.yml against
  // whatever base it is given, so anything outside github.com must not be accepted.
  assert.ok(/github\\\.com/.test(lib), 'the accepted shape is a github.com releases URL and nothing else');
});

test('a release publishes the record the updater reads', () => {
  // Without `latest.yml` on the release, every installed copy stays where it is. The
  // artifact and the upload both have to carry it, or the two drift apart.
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'electron-release.yml'), 'utf8');
  assert.ok(workflow.includes('dist-electron/latest.yml'), 'the artifact must carry latest.yml');
  assert.ok(workflow.includes('installer/latest.yml'), 'and the release must publish it');
  assert.ok(workflow.includes('.blockmap'), 'and the blockmap, so a download can be differential');
});

test('the feed reaches the library at runtime, so a baked one cannot disagree', () => {
  // electron-builder infers a `github` publish config from the git remote and writes an
  // `app-update.yml` even with no `publish:` block. It is inert here: `setFeedURL` replaces
  // the provider, and the packaged app starts with that file renamed away. Asserting the
  // file is absent would therefore assert something untrue and break the moment the remote
  // is renamed. What matters is that the runtime URL wins, which is a line of code.
  const main = readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /setFeedURL\(\{\s*provider:'generic',\s*url:feedUrl\s*\}\)/,
    'the packaged build must hand the library its feed');
  assert.ok(!/^publish:/m.test(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')),
    'no publish: block, so there is no second declaration of the feed to drift');
});

test('a packaged build still produces the record a release publishes', { skip: !existsSync(path.join(root, 'dist-electron', 'latest.yml')) && 'run `npm run desktop:package` first' }, () => {
  // Not the same thing as the baked config: this is what the updater fetches, and without
  // it on the release every installed copy stays where it is.
  assert.ok(existsSync(path.join(root, 'dist-electron', 'latest.yml')),
    'latest.yml is what a release publishes and what the updater fetches');
  const record = readFileSync(path.join(root, 'dist-electron', 'latest.yml'), 'utf8');
  for (const key of ['version:', 'files:', 'sha512:', 'path:']) {
    assert.ok(record.includes(key), `latest.yml must carry ${key}`);
  }
  assert.ok(existsSync(path.join(root, 'dist-electron', 'Sunday-Room-1.0.2-Setup-x64.exe.blockmap')),
    'the blockmap lets a later download be differential');
});
