import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stageName = '.desktop-runtime/rust-collector-addon';
const manifestName = 'active.json';

async function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${executable} ${args.join(' ')} failed (${code})\n${output}`)));
  });
}

async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function sourceFiles(root) {
  const files = [
    'native/collector/Cargo.toml', 'native/collector/Cargo.lock', 'native/collector/build.rs',
    'lib/football/source-registry.json', 'lib/football/domain/college-teams.generated.ts',
    'lib/football/domain/college-teams.coverage.json', 'scripts/build-rust-collector.mjs',
  ];
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(child);
      else throw new Error(`Unexpected Rust source entry: ${child}`);
    }
  }
  await visit('native/collector/src');
  return files.sort();
}

async function inputIdentity(root) {
  const digest = createHash('sha256');
  digest.update(`platform:${process.platform}\0arch:${process.arch}\0`);
  for (const [name, value] of Object.entries(process.env).filter(([name]) =>
    name === 'RUSTFLAGS' || name === 'CARGO_ENCODED_RUSTFLAGS' || name === 'CARGO_BUILD_TARGET' ||
    name === 'RUSTC_WRAPPER' || name.startsWith('CARGO_PROFILE_RELEASE_') ||
    /^CARGO_TARGET_.*_RUSTFLAGS$/.test(name)).sort(([a], [b]) => a.localeCompare(b)))
    digest.update(`env:${name}=${value}\0`);
  for (const relative of await sourceFiles(root)) {
    digest.update(`file:${relative}\0`);
    digest.update(await readFile(path.join(root, relative)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function nativeLibrary(target) {
  if (target.includes('windows')) return 'sports_hub_collector.dll';
  if (target.includes('darwin')) return 'libsports_hub_collector.dylib';
  return 'libsports_hub_collector.so';
}

function stagedDirectory(root) { return path.join(root, ...stageName.split('/')); }

export async function activeCollectorAddon(root = defaultRoot) {
  const stage = stagedDirectory(root);
  const file = path.join(stage, manifestName);
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.inputKey) ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceKey) ||
      !/^[a-f0-9]{64}$/.test(manifest.binarySha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.registrySha256) ||
      manifest.filename !== `collector-${manifest.binarySha256}.node`)
    throw new Error(`Invalid Rust collector manifest: ${file}`);
  const binary = path.join(stage, manifest.filename);
  if (!(await stat(binary)).isFile() || await fileHash(binary) !== manifest.binarySha256)
    throw new Error(`Missing or stale Rust collector addon: ${binary}`);
  const registry = path.join(stage, 'source-registry.json');
  if (!(await stat(registry)).isFile() || await fileHash(registry) !== manifest.registrySha256)
    throw new Error(`Missing or stale Rust collector registry: ${registry}`);
  return { ...manifest, directory: stage, binary, registry, manifestFile: file };
}

async function packageStage(root, active) {
  const directory = path.join(stagedDirectory(root), 'package');
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      !relative.replaceAll('\\', '/').startsWith(`${stageName}/`))
    throw new Error('Invalid collector package staging directory');
  await mkdir(directory, { recursive: true });
  const binary = path.join(directory, active.filename);
  try { await copyFile(active.binary, binary, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await fileHash(binary) !== active.binarySha256) throw new Error(`Collector package binary is corrupt: ${binary}`);
  const registry = path.join(directory, 'source-registry.json');
  if (await fileHash(registry).catch(() => null) !== active.registrySha256) {
    const temporary = path.join(directory, `source-registry.${process.pid}.tmp`);
    await copyFile(active.registry, temporary);
    await rename(temporary, registry);
  }
  const manifest = path.join(directory, manifestName);
  if (await readFile(manifest, 'utf8').catch(() => null) !== await readFile(active.manifestFile, 'utf8')) {
    const temporary = path.join(directory, `active.${process.pid}.tmp`);
    await copyFile(active.manifestFile, temporary);
    await rename(temporary, manifest);
  }
  return directory;
}

export async function ensureCollectorAddon(root = defaultRoot, { force = false, packageArtifact = false } = {}) {
  const absoluteRoot = await realpath(root);
  const inputKey = await inputIdentity(absoluteRoot);
  try {
    const active = await activeCollectorAddon(absoluteRoot);
    if (!force && active.inputKey === inputKey && active.platform === process.platform && active.arch === process.arch) {
      if (packageArtifact) await packageStage(absoluteRoot, active);
      return active;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const manifest = path.join(stagedDirectory(absoluteRoot), manifestName);
      if (await stat(manifest).catch(() => null)) throw error;
    }
  }

  const rustc = await command('rustc', ['--version', '--verbose'], { cwd: absoluteRoot });
  const target = /^host: (.+)$/m.exec(rustc)?.[1];
  if (!target) throw new Error('Rust compiler did not report a host target');
  const cargo = await command('cargo', ['--version'], { cwd: absoluteRoot });
  const sourceKey = createHash('sha256').update(`${inputKey}\0${target}\0${rustc}\0${cargo}`).digest('hex');
  const crate = path.join(absoluteRoot, 'native', 'collector');
  const build = await command('cargo', ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(crate, 'Cargo.toml')],
    { cwd: absoluteRoot });
  if (build) process.stderr.write(`${build}\n`);
  const compiled = path.join(crate, 'target', target, 'release', nativeLibrary(target));
  const binarySha256 = await fileHash(compiled);
  const filename = `collector-${binarySha256}.node`;
  const stage = stagedDirectory(absoluteRoot);
  await mkdir(stage, { recursive: true });
  const binary = path.join(stage, filename);
  try { await copyFile(compiled, binary, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await fileHash(binary) !== binarySha256) throw new Error(`Content-addressed Rust collector addon is corrupt: ${binary}`);
  const registry = path.join(absoluteRoot, 'lib/football/source-registry.json');
  const registrySha256 = await fileHash(registry);
  await copyFile(registry, path.join(stage, 'source-registry.json'));
  const manifest = { version: 1, inputKey, sourceKey, platform: process.platform, arch: process.arch,
    target, rustc, cargo, filename, binarySha256, registrySha256 };
  const temp = path.join(stage, `${manifestName}.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, path.join(stage, manifestName));
  const active = await activeCollectorAddon(absoluteRoot);
  if (packageArtifact) await packageStage(absoluteRoot, active);
  return active;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const active = await ensureCollectorAddon(defaultRoot, { force: process.argv.includes('--force'),
      packageArtifact: process.argv.includes('--package') });
    console.log(`Rust collector ready: ${active.filename}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
