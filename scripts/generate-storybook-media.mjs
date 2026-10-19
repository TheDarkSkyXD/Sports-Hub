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

const formats=resolve(dirname(output),'media');
mkdirSync(formats,{recursive:true});
const commands=[
  ['-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t','12','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','48','-movflags','+faststart','sample.mp4'],
  ['-i','sample.mp4','-c','copy','-f','flv','sample.flv'],
  ['-i','sample.mp4','-c','copy','-f','mpegts','sample.mpegts'],
  ['-i','sample.mp4','-c','copy','-f','dash','-seg_duration','2','manifest.mpd'],
];
for(const args of commands){
  const generated=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y',...args],{cwd:formats,stdio:'inherit',windowsHide:true});
  if(generated.error)throw generated.error;
  if(generated.status!==0)process.exit(generated.status??1);
}
