import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function preparePlaybackWorker(root = path.resolve('.')) {
  const source = path.join(root, 'node_modules/hls.js/dist/hls.worker.js');
  const target = path.join(root, 'public/generated/hls.worker.js');
  const installed = await readFile(source);
  const prepared = await readFile(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (prepared?.equals(installed)) return;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, installed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await preparePlaybackWorker();
