import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { blocksSourceRequest } = require('../desktop/source-adblock.cjs');
const cases = [
  { url: 'https://dlive.sx/pixel', resourceType: 'xhr', blocked: false },
  { url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', resourceType: 'script', blocked: true },
  { url: 'https://media.example/game.m3u8?token=fixture', resourceType: 'xhr', blocked: false },
];
const memoryBefore = process.memoryUsage();
const started = performance.now();
const decisions = cases.map(({ blocked, ...details }) => {
  const actual = blocksSourceRequest({ ...details, referrer: 'https://dlive.sx/stream/fixture' });
  assert.equal(actual, blocked, details.url);
  return { ...details, blocked: actual };
});
const initialMs = performance.now() - started;
const memoryAfter = process.memoryUsage();
const warm = performance.now();
for (let index = 0; index < 10_000; index++) {
  const { blocked, ...details } = cases[index % cases.length];
  assert.equal(blocksSourceRequest({ ...details, referrer: 'https://dlive.sx/stream/fixture' }), blocked);
}
const result = { initialThreeRequestsMs: initialMs, warmRequests: 10_000,
  warmRequestsMs: performance.now() - warm, rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
  heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed, decisions };
const output = resolve(process.argv[2] ?? '.desktop-runtime/media-audit-fixes/filter-performance.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
