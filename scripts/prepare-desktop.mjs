import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const standalone = path.resolve('.next/standalone');
const server = path.join(standalone, 'server.js');
const staticFiles = path.resolve('.next/static');

await stat(server);
await stat(staticFiles);
await mkdir(path.join(standalone, '.next'), { recursive: true });
await cp(staticFiles, path.join(standalone, '.next/static'), { recursive: true, force: true });
await cp(path.resolve('public'), path.join(standalone, 'public'), { recursive: true, force: true });

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const packages = lock.packages;
const pending = ['node_modules/cheerio', 'node_modules/zod', 'node_modules/sharp'];
const copied = new Set();
function resolveDependency(parent, name) {
  for (let current = parent; ; current = current.slice(0, current.lastIndexOf('/node_modules/'))) {
    const nested = `${current}/node_modules/${name}`;
    if (packages[nested]) return nested;
    if (!current.includes('/node_modules/')) break;
  }
  const root = `node_modules/${name}`;
  if (packages[root]) return root;
  throw new Error(`Missing packaged worker dependency: ${name}`);
}
while (pending.length) {
  const entry = pending.pop();
  if (copied.has(entry)) continue;
  if (!entry.startsWith('node_modules/') || entry.includes('..') || !packages[entry]) throw new Error(`Invalid worker dependency: ${entry}`);
  copied.add(entry);
  const source = path.resolve(entry);
  await stat(source);
  const destination = path.join(standalone, ...entry.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
  const dependencies = { ...packages[entry].dependencies, ...packages[entry].optionalDependencies };
  for (const name of Object.keys(dependencies)) {
    const dependency = resolveDependency(entry, name);
    if (Object.hasOwn(packages[entry].optionalDependencies ?? {}, name)) {
      const installed = await stat(path.resolve(dependency)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!installed) continue;
    }
    pending.push(dependency);
  }
}
await stat(path.join(standalone, 'lib/football/runtime/worker.ts'));
await stat(path.join(standalone, 'lib/football/runtime/composition.ts'));
await stat(path.join(standalone, 'lib/playback/probe.ts'));
await stat(path.join(standalone, 'lib/sunday.ts'));
console.log(`Prepared standalone worker and ${copied.size} runtime package trees.`);
