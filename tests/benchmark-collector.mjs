import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!['--root', '--iterations', '--output'].includes(name) || !value || options.has(name)) {
    throw new Error('Usage: node --expose-gc tests/benchmark-collector.mjs [--root PATH] [--iterations COUNT] [--output PATH]');
  }
  options.set(name, value);
}
const root = resolve(options.get('--root') ?? checkout);
const iterations = Number(options.get('--iterations') ?? 100);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10000) {
  throw new Error('Iterations must be an integer between 1 and 10000');
}
const golden = JSON.parse(readFileSync(join(checkout, 'tests/fixtures/collector-parity.json'), 'utf8'));
assert.equal(golden.version, 1);
const { SOURCES, parseListings } = await import(pathToFileURL(join(root, 'lib/football/adapters/sources.ts')).href);
const cases = golden.inputs.cases.map(input => {
  const source = SOURCES.find(item => item.id === input.sourceId);
  assert.ok(source, `Missing benchmark source ${input.sourceId}`);
  const at = input.at ?? golden.at;
  const actual = JSON.parse(JSON.stringify(parseListings(source, input.body, at)));
  assert.deepEqual(actual, golden.expected.listings[input.id].parsed, `Parity failed for ${input.id}`);
  return { source, body: input.body, at };
});
for (let round = 0; round < 3; round++) {
  for (const item of cases) parseListings(item.source, item.body, item.at);
}
globalThis.gc?.();
const rssBefore = process.memoryUsage().rss;
let rssPeak = rssBefore;
let observations = 0;
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
for (let round = 0; round < iterations; round++) {
  for (const item of cases) {
    observations += parseListings(item.source, item.body, item.at).observations.length;
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
}
const elapsedMs = performance.now() - wallStart;
const cpu = process.cpuUsage(cpuStart);
const expectedObservations = golden.inputs.cases.reduce((count, input) =>
  count + golden.expected.listings[input.id].parsed.observations.length, 0) * iterations;
assert.equal(observations, expectedObservations);
const result = {
  version: 1, root, node: process.version, platform: process.platform, arch: process.arch,
  iterations, cases: cases.length, observations,
  wallMs: Number(elapsedMs.toFixed(2)), cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
  rssBeforeBytes: rssBefore, sampledPeakRssBytes: rssPeak,
  at: new Date().toISOString(),
};
if (options.has('--output')) writeFileSync(resolve(options.get('--output')), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
