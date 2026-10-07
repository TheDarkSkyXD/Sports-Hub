import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { selectUpdateFeedUrl, defaultUpdateFeedUrl } = require('../desktop/update.cjs');
const yaml = require('js-yaml');

test('the installed feed stays pinned while development accepts only a valid override', () => {
  const fork = 'https://github.com/example/Sports-Hub/releases/latest/download';
  assert.equal(selectUpdateFeedUrl(true, fork), defaultUpdateFeedUrl);
  assert.equal(selectUpdateFeedUrl(false, fork), fork);
  assert.equal(selectUpdateFeedUrl(false, ` ${fork} `), fork);
  assert.equal(selectUpdateFeedUrl(false, 'https://example.com/latest.yml'), defaultUpdateFeedUrl);
  assert.equal(selectUpdateFeedUrl(false, `${fork}?asset=other`), defaultUpdateFeedUrl);
  assert.equal(selectUpdateFeedUrl(false, undefined), defaultUpdateFeedUrl);
});

const WorkflowSchema = z.object({
  jobs: z.object({
    package: z.object({ steps: z.array(z.object({
      uses: z.string().optional(),
      run: z.string().optional(),
      env: z.record(z.string()).optional(),
      with: z.record(z.unknown()).optional(),
    }).passthrough()) }),
    'prepare-release': z.object({ steps: z.array(z.object({
      uses: z.string().optional(),
      with: z.record(z.unknown()).optional(),
      run: z.string().optional(),
    }).passthrough()) }),
  }),
});
const UploadWithSchema = z.object({
  name: z.string(), path: z.string(), 'if-no-files-found': z.string(),
});
const ReleaseRecordSchema = z.object({
  version: z.string(),
  files: z.array(z.object({ url: z.string(), sha512: z.string() })).nonempty(),
  path: z.string(),
  sha512: z.string(),
});
const releaseDir = process.env.SUNDAY_ROOM_RELEASE_DIR;

test('the release workflow uploads and publishes the installer and update record', () => {
  const source = readFileSync(path.join(root, '.github', 'workflows', 'electron-release.yml'), 'utf8');
  const workflow = WorkflowSchema.parse(yaml.load(source));
  const upload = workflow.jobs.package.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const uploadWith = UploadWithSchema.parse(upload?.with);
  assert.equal(uploadWith.name, 'sunday-room-windows-installer');
  assert.equal(uploadWith['if-no-files-found'], 'error');
  assert.deepEqual(uploadWith.path.trim().split(/\s+/), [
    'dist-electron/Sunday-Room-*-Setup-x64.exe',
    'dist-electron/latest.yml',
  ]);
  const packageSteps = workflow.jobs.package.steps;
  const packageIndex = packageSteps.findIndex(step => step.run === 'npm run desktop:package');
  const recordCheckIndex = packageSteps.findIndex(step => step.run === 'node --experimental-strip-types --test tests/updater-feed.test.ts');
  assert.ok(packageIndex >= 0 && recordCheckIndex > packageIndex,
    'the packaged update record must be checked after packaging');
  assert.equal(packageSteps[recordCheckIndex].env?.SUNDAY_ROOM_RELEASE_DIR, 'dist-electron',
    'release artifact checks must be explicit so local tests use source');
  const releaseSteps = workflow.jobs['prepare-release'].steps;
  assert.equal(releaseSteps.find(step => step.uses?.startsWith('actions/download-artifact@'))?.with?.name,
    uploadWith.name);
  const publish = releaseSteps.find(step => step.run?.includes('gh release create'))?.run;
  assert.ok(publish);
  for (const asset of ['installer/*.exe', 'installer/latest.yml']) {
    assert.ok(publish.includes(asset), `${asset} must be attached to the release`);
  }
  assert.doesNotMatch(publish, /\.blockmap\b/);
});

test('a packaged build produces an update record and installer without a blockmap', { skip: !releaseDir && 'release artifacts are checked only when SUNDAY_ROOM_RELEASE_DIR is set' }, () => {
  assert.ok(releaseDir);
  const { version } = z.object({ version: z.string() }).parse(
    JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')),
  );
  const record = ReleaseRecordSchema.parse(yaml.load(readFileSync(path.join(releaseDir, 'latest.yml'), 'utf8')));
  assert.equal(record.version, version);
  assert.equal(record.path, `Sunday-Room-${version}-Setup-x64.exe`);
  assert.ok(record.files.some(file => file.url === record.path && file.sha512 === record.sha512));
  assert.ok(existsSync(path.join(releaseDir, record.path)), `${record.path} must exist`);
  assert.ok(!existsSync(path.join(releaseDir, `${record.path}.blockmap`)), `${record.path}.blockmap must be absent`);
});
