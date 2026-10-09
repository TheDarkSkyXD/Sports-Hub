const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readdir, lstat, realpath, readFile } = require('node:fs/promises');
const path = require('node:path');

const sourceDirectories = ['app', 'components', 'desktop', 'hooks', 'lib', 'native/collector/src', 'public', 'styles', 'vendor'];
const sourceFiles = ['next.config.ts', 'postcss.config.mjs', 'tsconfig.json', 'package.json', 'package-lock.json',
  'scripts/prepare-desktop.mjs', 'scripts/build-rust-collector.mjs', 'native/collector/Cargo.toml',
  'native/collector/Cargo.lock', 'native/collector/build.rs', 'native/collector/bridge.cjs',
  'native/collector/bridge.d.cts', 'node_modules/.package-lock.json'];

function publicEnvironment() {
  return JSON.stringify(Object.entries(process.env).filter(([name]) => name.startsWith('NEXT_PUBLIC_'))
    .sort(([left], [right]) => left.localeCompare(right)));
}

async function sourceIdentity(root, inheritedPublicEnvironment = publicEnvironment()) {
  const names = [];
  const realRoot = await realpath(root);
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const name = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Source input is a symbolic link: ${name}`);
      const relativeTarget = path.relative(realRoot, await realpath(path.join(root, name)));
      if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget))
        throw new Error(`Source input leaves the checkout: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) names.push(name);
    }
  }
  for (const directory of sourceDirectories) {
    try { await visit(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const file of sourceFiles) {
    try {
      const details = await lstat(path.join(root, file));
      if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Invalid source input: ${file}`);
      names.push(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const rootEntries = await readdir(root);
  names.push(...rootEntries.filter(name => /^\.env(?:\..+)?$/.test(name)));
  const active = path.join(root, '.desktop-runtime', 'rust-collector-addon', 'active.json');
  const manifest = JSON.parse(await readFile(active, 'utf8'));
  if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.binarySha256) ||
      manifest.filename !== `collector-${manifest.binarySha256}.node`)
    throw new Error('Invalid Rust collector manifest for source identity');
  names.push('.desktop-runtime/rust-collector-addon/active.json',
    `.desktop-runtime/rust-collector-addon/${manifest.filename}`,
    '.desktop-runtime/rust-collector-addon/source-registry.json');
  names.sort();
  const digest = createHash('sha256');
  digest.update(`node:${process.versions.node}\0`);
  digest.update(`env:${inheritedPublicEnvironment}\0`);
  for (const name of names) {
    digest.update(`file:${name}\0`);
    for await (const chunk of createReadStream(path.join(root, name))) digest.update(chunk);
    digest.update('\0');
  }
  return digest.digest('hex');
}

module.exports = { sourceIdentity, publicEnvironment };
