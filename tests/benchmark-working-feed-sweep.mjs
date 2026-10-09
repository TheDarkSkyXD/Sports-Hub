import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';

const [source, clockValue, runsValue = '5'] = process.argv.slice(2);
const clock = Number(clockValue);
const runs = Number(runsValue);
if (!source || !Number.isSafeInteger(clock) || !Number.isSafeInteger(runs) || runs < 1) {
  throw new Error('Usage: node --experimental-strip-types tests/benchmark-working-feed-sweep.mjs <frozen.sqlite> <clock-ms> [runs]');
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function savedRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT payload FROM working_feeds ORDER BY game_id,candidate_id').all().map(row => row.payload);
  } finally { db.close(); }
}

async function replay(mode) {
  const directory = mkdtempSync(join(tmpdir(), 'resource-sweep-'));
  const path = join(directory, 'football.sqlite');
  copyFileSync(source, path);
  const replace = FootballStore.prototype.replaceWorkingIdentity;
  let calls = 0;
  FootballStore.prototype.replaceWorkingIdentity = function (...args) {
    calls++;
    return replace.apply(this, args);
  };
  let coordinator;
  try {
    coordinator = createFootballCoordinator(path, {
      now: () => clock,
      readSchedule: async () => { throw new Error('Schedule reads are outside the replay'); },
      readHtml: async () => { throw new Error('Source reads are outside the replay'); },
    });
    if (mode === 'baseline') {
      const reconcile = coordinator.reconcileProbeJobs;
      coordinator.reconcileProbeJobs = function () { return reconcile.call(this, true); };
    }
    const before = hash(savedRows(path));
    calls = 0;
    const started = performance.now();
    const cpu = process.cpuUsage();
    for (let index = 0; index < 6; index++) coordinator.sweep();
    const wallMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const after = hash(savedRows(path));
    assert.equal(after, before);
    return { mode, calls, wallMs, cpuMs: (used.user + used.system) / 1000, rows: savedRows(path).length,
      savedRowsHash: after, boardHash: hash(coordinator.board()), sourcesHash: hash(coordinator.sourcesSnapshot()) };
  } finally {
    if (coordinator) await coordinator.stop();
    FootballStore.prototype.replaceWorkingIdentity = replace;
    rmSync(directory, { recursive: true, force: true });
  }
}

const samples = [];
for (let index = 0; index < runs; index++) {
  for (const mode of index % 2 ? ['changed', 'baseline'] : ['baseline', 'changed']) samples.push(await replay(mode));
}
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const byMode = mode => samples.filter(sample => sample.mode === mode);
const baseline = byMode('baseline'), changed = byMode('changed');
for (let index = 0; index < runs; index++) {
  assert.equal(changed[index].savedRowsHash, baseline[index].savedRowsHash);
  assert.equal(changed[index].boardHash, baseline[index].boardHash);
  assert.equal(changed[index].sourcesHash, baseline[index].sourcesHash);
}
console.log(JSON.stringify({ source, clock, sweepsPerRun: 6, runsPerMode: runs,
  baseline: { calls: median(baseline.map(row => row.calls)), wallMs: median(baseline.map(row => row.wallMs)), cpuMs: median(baseline.map(row => row.cpuMs)) },
  changed: { calls: median(changed.map(row => row.calls)), wallMs: median(changed.map(row => row.wallMs)), cpuMs: median(changed.map(row => row.cpuMs)) },
  rows: baseline[0].rows, savedRowsHash: baseline[0].savedRowsHash,
  boardHash: baseline[0].boardHash, sourcesHash: baseline[0].sourcesHash, samples }, null, 2));
