const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const MANIFEST = 'active.json';

function hashFile(file) {
  const hash = createHash('sha256');
  const bytes = readFileSync(/* turbopackIgnore: true */ file);
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
    if (!existsSync(/* turbopackIgnore: true */ path.join(directory, MANIFEST)))
      throw new Error(`Rust collector manifest missing: ${path.join(directory, MANIFEST)}`);
    return directory;
  }
  const directory = candidateDirectories().find(value => existsSync(/* turbopackIgnore: true */ path.join(value, MANIFEST)));
  if (!directory) throw new Error(`Rust collector addon missing; searched ${candidateDirectories().join(', ')}`);
  return directory;
}

function loadAddon() {
  const directory = activeDirectory();
  const manifestFile = path.join(directory, MANIFEST);
  let manifest;
  try { manifest = JSON.parse(readFileSync(/* turbopackIgnore: true */ manifestFile, 'utf8')); }
  catch (error) { throw new Error(`Rust collector manifest unreadable: ${manifestFile}`, { cause: error }); }
  if (manifest?.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.binarySha256) ||
      !/^[a-f0-9]{64}$/.test(manifest.registrySha256) ||
      manifest.filename !== `collector-${manifest.binarySha256}.node`)
    throw new Error(`Rust collector manifest invalid: ${manifestFile}`);
  const binary = path.join(directory, manifest.filename);
  const registry = path.join(directory, 'source-registry.json');
  for (const [file, expected] of [[binary, manifest.binarySha256], [registry, manifest.registrySha256]]) {
    if (!existsSync(/* turbopackIgnore: true */ file) || hashFile(file) !== expected)
      throw new Error(`Rust collector artifact missing or stale: ${file}`);
  }
  let addon;
  try { addon = require(/* turbopackIgnore: true */ binary); }
  catch (error) { throw new Error(`Rust collector addon failed to load: ${binary}`, { cause: error }); }
  if (typeof addon.Collector !== 'function') throw new Error(`Rust collector export missing: ${binary}`);
  return { Collector: addon.Collector, NativeStore: addon.NativeStore, NativePipeline: addon.NativePipeline, NativeSchedule: addon.NativeSchedule,
    pipelineDomain: addon.pipelineDomain, pipelineView: addon.pipelineView, createNativeMatcher: addon.createNativeMatcher,
    registryJson: readFileSync(/* turbopackIgnore: true */ registry, 'utf8') };
}

let loaded;
function createNativeCollector(fixtureMode = false) {
  loaded ||= loadAddon();
  return new loaded.Collector(loaded.registryJson, fixtureMode);
}

function createNativeStore(databasePath, ownerToken, reclaimToken) {
  loaded ||= loadAddon();
  if (typeof loaded.NativeStore !== 'function') throw new Error('Rust pipeline store is missing; rebuild the native addon.');
  return new loaded.NativeStore(databasePath, ownerToken, reclaimToken);
}

function createNativePipeline(databasePath, configJson) {
  loaded ||= loadAddon();
  if (typeof loaded.NativePipeline !== 'function') throw new Error('Rust pipeline owner is missing; rebuild the native addon.');
  return new loaded.NativePipeline(databasePath, configJson);
}

function pipelineDomain(operation, inputJson) {
  loaded ||= loadAddon();
  if (typeof loaded.pipelineDomain !== 'function') throw new Error('Rust pipeline domain is missing; rebuild the native addon.');
  return loaded.pipelineDomain(operation, inputJson);
}

function pipelineView(operation, inputJson) {
  loaded ||= loadAddon();
  if (typeof loaded.pipelineView !== 'function') throw new Error('Rust pipeline views are missing; rebuild the native addon.');
  return loaded.pipelineView(operation, inputJson);
}

function createNativeMatcher(kind, gamesJson, mode = 'current') {
  loaded ||= loadAddon();
  if (typeof loaded.createNativeMatcher !== 'function') throw new Error('Rust pipeline matcher is missing; rebuild the native addon.');
  return loaded.createNativeMatcher(kind, gamesJson, mode);
}

function createNativeSchedule(fixtureMode = false) {
  loaded ||= loadAddon();
  if (typeof loaded.NativeSchedule !== 'function') throw new Error('Rust pipeline schedule is missing; rebuild the native addon.');
  return new loaded.NativeSchedule(loaded.registryJson, fixtureMode);
}

module.exports = { createNativeCollector, createNativeStore, createNativePipeline, createNativeMatcher, createNativeSchedule, pipelineDomain, pipelineView };
