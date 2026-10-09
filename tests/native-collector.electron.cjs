const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { app } = require('electron');
const { createNativeCollector } = require('../native/collector/bridge.cjs');

const mode = process.argv.find(value => value.startsWith('--collector-mode='))?.split('=')[1];
const output = process.argv.find(value => value.startsWith('--collector-output='))?.slice('--collector-output='.length);
assert.ok(['main-first', 'main-after'].includes(mode));
assert.ok(output && path.isAbsolute(output));
const goldenPath = path.join(__dirname, 'fixtures', 'collector-parity.json');
const bridgePath = path.join(__dirname, '..', 'native', 'collector', 'bridge.cjs');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
const actualSourceUrl = golden.expected.registry.find(source => source.id === 'nflstreams')?.url;
assert.ok(actualSourceUrl);

function checkParsers(collector) {
  assert.equal(collector.sourceCount(), 47);
  for (const input of golden.inputs.cases) {
    const source = golden.expected.registry.find(value => value.id === input.sourceId);
    const actual = JSON.parse(collector.parseListings(JSON.stringify(source), input.body, input.at ?? golden.at));
    assert.deepEqual(actual, golden.expected.listings[input.id].parsed, input.id);
  }
}

async function read(collector, body) {
  collector.enqueueFixture(JSON.stringify({ url: actualSourceUrl, body }));
  const request = collector.beginRequest();
  const result = JSON.parse(await collector.readHtml(request, actualSourceUrl));
  assert.deepEqual(result, { kind: 'complete', body });
}

async function worker(index, pending = false) {
  const code = `
    const {parentPort,workerData} = require('node:worker_threads');
    const assert = require('node:assert/strict');
    const {createNativeCollector} = require(workerData.bridgePath);
    const collector = createNativeCollector(true);
    globalThis.fixtureCollector = collector;
    assert.equal(collector.sourceCount(), 47);
    collector.enqueueFixture(JSON.stringify({url:workerData.url,body:'worker-'+workerData.index}));
    (async () => {
      const request = collector.beginRequest();
      const result = JSON.parse(await collector.readHtml(request, workerData.url));
      assert.deepEqual(result,{kind:'complete',body:'worker-'+workerData.index});
      if (workerData.pending) {
        collector.enqueueFixture(JSON.stringify({url:workerData.url,pending:true}));
        collector.readHtml(collector.beginRequest(),workerData.url);
        while (JSON.parse(collector.fixtureRequests()).length < 2)
          await new Promise(resolve=>setTimeout(resolve,1));
      }
      parentPort.postMessage(result.body);
    })().catch(error=>{throw error;});
  `;
  const child = new Worker(code, { eval: true, workerData: { bridgePath, url: actualSourceUrl, index, pending } });
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Collector worker ${index} did not finish`)), 10_000);
      child.once('message', value => {
        clearTimeout(deadline);
        try {
          assert.equal(value, `worker-${index}`);
          resolve();
        } catch (error) { reject(error); }
      });
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', code => {
        clearTimeout(deadline);
        reject(new Error(`Collector worker ${index} exited before its result (${code})`));
      });
    });
  } finally { await child.terminate(); }
}

app.whenReady().then(async () => {
  let collector;
  if (mode === 'main-first') {
    collector = createNativeCollector(true);
    checkParsers(collector);
    await read(collector, 'main-before');
  }
  for (let index = 0; index < 10; index++) await worker(index);
  collector ||= createNativeCollector(true);
  checkParsers(collector);
  await read(collector, 'main-after');
  for (let index = 10; index < 13; index++) await worker(index, true);
  await read(collector, 'main-after-pending-unloads');
  const result = { mode, electron: process.versions.electron, node: process.versions.node,
    workerRestarts: 10, pendingWorkerUnloads: 3, listingCases: golden.inputs.cases.length,
    sources: collector.sourceCount(), pid: process.pid };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
