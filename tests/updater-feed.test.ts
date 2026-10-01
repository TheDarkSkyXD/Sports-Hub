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

test('the release workflow uploads and publishes the installer and update record', () => {
  const source = readFileSync(path.join(root, '.github', 'workflows', 'electron-release.yml'), 'utf8');
  const workflow = WorkflowSchema.parse(yaml.load(source));
  const upload = workflow.jobs.package.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const uploadWith = UploadWithSchema.parse(upload?.with);
  assert.equal(uploadWith.name, 'sunday-room-windows-installer');
  assert.equal(uploadWith['if-no-files-found'], 'error');
  assert.deepEqual(uploadWith.path.trim().split(/\s+/), [
    'dist-electron/Sunday-Room-*-Setup-x64.exe',
    'dist-electron/Sunday-Room-*-Setup-x64.exe.blockmap',
    'dist-electron/latest.yml',
  ]);
  const releaseSteps = workflow.jobs['prepare-release'].steps;
  assert.equal(releaseSteps.find(step => step.uses?.startsWith('actions/download-artifact@'))?.with?.name,
    uploadWith.name);
  const publish = releaseSteps.find(step => step.run?.includes('gh release create'))?.run;
  assert.ok(publish);
  for (const asset of ['installer/*.exe', 'installer/*.exe.blockmap', 'installer/latest.yml']) {
    assert.ok(publish.includes(asset), `${asset} must be attached to the release`);
  }
});

test('a packaged build produces the update record', { skip: !existsSync(path.join(root, 'dist-electron', 'latest.yml')) && 'run `npm run desktop:package` first' }, () => {
  const { version } = z.object({ version: z.string() }).parse(
    JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')),
  );
  const record = z.object({
    version: z.string(),
    path: z.string(),
    sha512: z.string(),
    files: z.array(z.object({ url: z.string(), sha512: z.string(), size: z.number().positive() })).nonempty(),
  }).parse(yaml.load(readFileSync(path.join(root, 'dist-electron', 'latest.yml'), 'utf8')));
  const installer = `Sunday-Room-${version}-Setup-x64.exe`;
  assert.equal(record.version, version);
  assert.equal(record.path, installer);
  assert.ok(record.files.some(file => file.url === installer && file.sha512 === record.sha512));
  assert.ok(existsSync(path.join(root, 'dist-electron', installer)), 'latest.yml must name the packaged installer');
  assert.ok(existsSync(path.join(root, 'dist-electron', `${installer}.blockmap`)), 'the installer must have a blockmap');
});
