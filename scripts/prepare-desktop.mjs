import { cp, mkdir, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const distDir = process.argv[2] ?? '.next';
if (distDir !== '.next' && !/^\.desktop-runtime\/local-builds\/[a-f0-9-]+$/.test(distDir))
  throw new Error('Invalid desktop build directory');
const standalone = path.resolve(distDir, 'standalone');
if (distDir !== '.next' && await realpath(path.join(standalone, 'node_modules')) === await realpath('node_modules'))
  throw new Error('This checkout links node_modules outside the standalone build. Install dependencies inside the checkout before building the local desktop server.');
const server = path.join(standalone, 'server.js');
const staticFiles = path.resolve(distDir, 'static');

await stat(server);
if (distDir !== '.next') {
  await cp(server, path.join(standalone, 'server.cjs'));
  await cp(path.resolve('package.json'), path.join(standalone, 'package.json'));
}
await stat(staticFiles);
await mkdir(path.join(standalone, distDir), { recursive: true });
await cp(staticFiles, path.join(standalone, distDir, 'static'), { recursive: true, force: true });
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
if (distDir !== '.next') {
  const aliases = path.join(standalone, distDir, 'node_modules');
  const sourceModules = await realpath('node_modules');
  const served = await realpath(standalone);
  async function materialize(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const alias = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith('@')) {
        await materialize(alias);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const relative = path.relative(sourceModules, await realpath(alias));
      const parts = relative.split(path.sep);
      if (relative.startsWith('..') || path.isAbsolute(relative) ||
          !(parts.length === 1 || (parts.length === 2 && parts[0].startsWith('@'))) ||
          !copied.has(`node_modules/${parts.join('/')}`))
        throw new Error(`Unowned standalone package alias: ${alias}`);
      const owned = path.join(standalone, 'node_modules', ...parts);
      const ownedRelative = path.relative(served, await realpath(owned));
      if (ownedRelative.startsWith('..') || path.isAbsolute(ownedRelative) || !(await stat(owned)).isDirectory())
        throw new Error(`Standalone package alias lacks an owned copy: ${alias}`);
      await unlink(alias);
      await cp(owned, alias, { recursive: true });
    }
  }
  await materialize(aliases);
}
await stat(path.join(standalone, 'lib/football/runtime/worker.ts'));
await stat(path.join(standalone, 'lib/football/runtime/schedule-worker.ts'));
await stat(path.join(standalone, 'lib/football/runtime/schedule-client.ts'));
await stat(path.join(standalone, 'lib/football/runtime/schedule-queue.ts'));
await stat(path.join(standalone, 'lib/football/runtime/composition.ts'));
await stat(path.join(standalone, 'lib/football/source-registry.json'));
for (const name of ['streamed', 'sportsfeed24', 'crichd', 'sportsbite', 'player-id'])
  await stat(path.join(standalone, `lib/football/adapters/${name}.ts`));
for (const name of ['catalog-stream', 'catalog-stream-policy'])
  await stat(path.join(standalone, `lib/playback/providers/${name}.ts`));
await stat(path.join(standalone, 'lib/playback/probe.ts'));
await stat(path.join(standalone, 'lib/sunday.ts'));
await stat(path.join(standalone, 'lib/game-timing.ts'));
console.log(`Prepared standalone worker and ${copied.size} runtime package trees.`);
