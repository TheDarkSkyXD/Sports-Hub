const { createHash, randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readFile, readdir, realpath, rename, stat, writeFile } = require('node:fs/promises');
const path = require('node:path');

const buildsPath = '.desktop-runtime/local-builds';
const completionFile = '.sunday-room-complete.json';
const pointerFile = 'current.json';

function buildDirectory(id) {
  if (!/^[a-f0-9-]+$/.test(id)) throw new Error('Invalid local build ID');
  return `${buildsPath}/${id}`;
}

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inventory(root) {
  const files = [];
  const realRoot = await realpath(root);
  async function visit(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = path.posix.join(directory.replaceAll('\\', '/'), entry.name);
      if (name === completionFile) continue;
      const absolute = path.join(root, name);
      const relativeTarget = path.relative(realRoot, await realpath(absolute));
      if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget))
        throw new Error(`Standalone entry leaves its build: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const details = await stat(absolute);
        files.push([name, details.size, await fileHash(absolute)]);
      } else throw new Error(`Unsupported standalone entry: ${name}`);
    }
  }
  await visit('');
  files.sort(([left], [right]) => left.localeCompare(right));
  return files;
}

async function buildIds(root, distDir) {
  const source = (await readFile(path.join(root, distDir, 'BUILD_ID'), 'utf8')).trim();
  const served = (await readFile(path.join(root, distDir, 'standalone', distDir, 'BUILD_ID'), 'utf8')).trim();
  return source === served ? source : null;
}

async function validateArtifact(root, distDir, sourceId) {
  const served = path.join(root, distDir, 'standalone');
  const manifest = JSON.parse(await readFile(path.join(served, completionFile), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.version !== 2 || manifest.sourceId !== sourceId || manifest.distDir !== distDir) return null;
  if (await buildIds(root, distDir) !== sourceId) return null;
  await stat(path.join(served, 'server.cjs'));
  await stat(path.join(served, distDir, 'static'));
  await stat(path.join(served, 'public'));
  const actual = await inventory(served);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) return null;
  return { kind: 'standalone', cwd: served, entry: path.join(served, 'server.cjs') };
}

async function reusableArtifact(root, sourceId) {
  let pointer;
  try { pointer = JSON.parse(await readFile(path.join(root, buildsPath, pointerFile), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  let distDir;
  try { distDir = buildDirectory(pointer.id); } catch { return null; }
  try { return await validateArtifact(root, distDir, sourceId); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError ||
        error.message?.startsWith('Standalone entry leaves its build:') ||
        error.message?.startsWith('Unsupported standalone entry:')) return null;
    throw error;
  }
}

async function completeArtifact(root, distDir, sourceId) {
  if (await buildIds(root, distDir) !== sourceId) throw new Error('Source changed while Next built the desktop server');
  const served = path.join(root, distDir, 'standalone');
  await stat(path.join(served, 'server.cjs'));
  await stat(path.join(served, distDir, 'static'));
  await stat(path.join(served, 'public'));
  const files = await inventory(served);
  const manifest = { version: 2, sourceId, distDir, files };
  const complete = path.join(served, completionFile);
  await writeFile(complete, JSON.stringify(manifest));
  const target = path.join(root, buildsPath, pointerFile);
  const temporary = `${target}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify({ id: path.basename(distDir) }));
  await rename(temporary, target);
  return { kind: 'standalone', cwd: served, entry: path.join(served, 'server.cjs') };
}

module.exports = { buildDirectory, reusableArtifact, completeArtifact };
