const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const MANIFEST = 'active.json';

function hashFile(file) {
  const hash = createHash('sha256');
  const bytes = readFileSync(file);
  hash.update(bytes);
  return hash.digest('hex');
}

function candidateDirectories() {
  const candidates = [];
  if (process.env.SUNDAY_ROOM_COLLECTOR_DIR) candidates.push(process.env.SUNDAY_ROOM_COLLECTOR_DIR);
  candidates.push(__dirname);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'native', 'collector'));
  candidates.push(path.resolve(__dirname, '..', '..', '.desktop-runtime', 'rust-collector-addon'));
  return [...new Set(candidates.map(value => path.resolve(value)))];
}

function activeDirectory() {
  const explicit = process.env.SUNDAY_ROOM_COLLECTOR_DIR;
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('SUNDAY_ROOM_COLLECTOR_DIR must be absolute');
    const directory = explicit;
    if (!existsSync(path.join(directory, MANIFEST)))
      throw new Error(`Rust collector manifest missing: ${path.join(directory, MANIFEST)}`);
    return directory;
  }
  const directory = candidateDirectories().find(value => existsSync(path.join(value, MANIFEST)));
  if (!directory) throw new Error(`Rust collector addon missing; searched ${candidateDirectories().join(', ')}`);
  return directory;
}

function loadAddon() {
  const directory = activeDirectory();
  const manifestFile = path.join(directory, MANIFEST);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); }
  catch (error) { throw new Error(`Rust collector manifest unreadable: ${manifestFile}`, { cause: error }); }
  if (manifest?.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.binarySha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.registrySha256) ||
      manifest.filename !== `collector-${manifest.binarySha256}.node`)
    throw new Error(`Rust collector manifest invalid: ${manifestFile}`);
  const binary = path.join(directory, manifest.filename);
  const registry = path.join(directory, 'source-registry.json');
  for (const [file, expected] of [[binary, manifest.binarySha256], [registry, manifest.registrySha256]]) {
    if (!existsSync(file) || hashFile(file) !== expected)
      throw new Error(`Rust collector artifact missing or stale: ${file}`);
  }
  let addon;
  try { addon = require(binary); }
  catch (error) { throw new Error(`Rust collector addon failed to load: ${binary}`, { cause: error }); }
  if (typeof addon.Collector !== 'function') throw new Error(`Rust collector export missing: ${binary}`);
  return { Collector: addon.Collector, registryJson: readFileSync(registry, 'utf8') };
}

let loaded;
function createNativeCollector(fixtureMode = false) {
  loaded ||= loadAddon();
  return new loaded.Collector(loaded.registryJson, fixtureMode);
}

module.exports = { createNativeCollector };
