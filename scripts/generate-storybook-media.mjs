import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';

if (!ffmpeg) throw new Error('ffmpeg-static did not provide an executable.');

const output = resolve(import.meta.dirname, '../.storybook/public/sample.webm');
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=12',
  '-t', '45', '-c:v', 'libvpx-vp9', '-b:v', '140k', '-an', '-y', output,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(output);
