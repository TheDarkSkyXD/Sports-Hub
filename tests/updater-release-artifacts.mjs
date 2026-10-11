import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { z } from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = process.env.SUNDAY_ROOM_RELEASE_DIR;
assert.ok(releaseDir, 'SUNDAY_ROOM_RELEASE_DIR must point to the packaged output');

const { version } = z.object({ version: z.string() }).parse(
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')),
);
const ReleaseRecordSchema = z.object({
  version: z.string(),
  files: z.array(z.object({ url: z.string(), sha512: z.string() })).nonempty(),
  path: z.string(),
  sha512: z.string(),
});
const record = ReleaseRecordSchema.parse(yaml.load(readFileSync(path.join(releaseDir, 'latest.yml'), 'utf8')));
assert.equal(record.version, version);
assert.equal(record.path, `Sunday-Room-${version}-Setup-x64.exe`);
assert.ok(record.files.some(file => file.url === record.path && file.sha512 === record.sha512),
  'the update file must match the installer path and sha512');
assert.ok(existsSync(path.join(releaseDir, record.path)), `${record.path} must exist`);
assert.ok(!existsSync(path.join(releaseDir, `${record.path}.blockmap`)), `${record.path}.blockmap must be absent`);
