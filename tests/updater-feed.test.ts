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
const readFeed = (file) => Object.fromEntries(
  readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.includes(':')).map(line => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }),
);

test('a development build is given a feed the library will actually read', () => {
  // `isUpdaterActive` is false for an unpackaged app unless `forceDevUpdateConfig` is set,
  // and the file it then reads is `dev-app-update.yml`. Miss either and every check in
  // development silently does nothing, which looks like "up to date" rather than an error.
  const main = readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  assert.ok(main.includes('forceDevUpdateConfig'),
    'without forceDevUpdateConfig the library skips every check in a development build');
  assert.ok(main.includes('dev-app-update.yml'), 'main.cjs must write the development feed');
  assert.ok(main.includes('SUNDAY_ROOM_UPDATE_SOURCE'), 'a development build must be able to point at a fork');
  const ignored = readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.ok(ignored.includes('dev-app-update.yml'),
    'the development feed is machine state and must not be committed');
});

test('the feed is declared once, in the place that bakes it into the build', () => {
  const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const publish = builder.slice(builder.indexOf('publish:'));
  assert.ok(publish.includes('provider: github'), 'only the GitHub provider is supported');
  const owner = /owner:\s*(\S+)/.exec(publish)?.[1];
  const repo = /repo:\s*(\S+)/.exec(publish)?.[1];
  assert.ok(owner && repo, 'the publish block must name an owner and a repository');
  assert.equal(`${owner}/${repo}`, 'TheDarkSkyXD/Sports-Hub', 'the shipped feed is this repository');
});

test('a release publishes the record the updater reads', () => {
  // Without `latest.yml` on the release, every installed copy stays where it is. The
  // artifact and the upload both have to carry it, or the two drift apart.
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'electron-release.yml'), 'utf8');
  assert.ok(workflow.includes('dist-electron/latest.yml'), 'the artifact must carry latest.yml');
  assert.ok(workflow.includes('installer/latest.yml'), 'and the release must publish it');
  assert.ok(workflow.includes('.blockmap'), 'and the blockmap, so a download can be differential');
});

test('the packaged build carries the feed it was given', { skip: !existsSync(path.join(root, 'dist-electron', 'win-unpacked', 'resources', 'app-update.yml')) && 'run `npm run desktop:package` first' }, () => {
  // Only meaningful after packaging, and `npm test` runs before that in the workflow, so
  // this skips rather than failing a build that has not packaged yet.
  const feed = readFeed(path.join(root, 'dist-electron', 'win-unpacked', 'resources', 'app-update.yml'));
  assert.equal(feed.provider, 'github');
  assert.equal(`${feed.owner}/${feed.repo}`, 'TheDarkSkyXD/Sports-Hub',
    'the baked feed must be the one electron-builder.yml declares');
});
