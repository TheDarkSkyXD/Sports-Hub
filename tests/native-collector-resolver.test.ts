import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createFixtureCollector, SourceFetchError, SOURCES } from '../lib/football/adapters/sources.ts';

const at = Date.parse('2026-10-08T21:10:00Z');

function streamedCase(sourceCount: number) {
  const collector = createFixtureCollector();
  const source = SOURCES.find(item => item.id === 'streamed');
  assert.ok(source);
  const catalog = readFileSync(new URL('./fixtures/broad-sources/streamed.json', import.meta.url), 'utf8');
  const observation = collector.parseListings(source, catalog, at).observations
    .find(item => item.title === 'Buffalo Sabres vs Dallas Stars');
  assert.ok(observation);
  const event = JSON.parse(catalog).find((item: { id: string }) => observation.url.endsWith(item.id));
  assert.ok(event);
  event.sources = Array.from({ length: sourceCount }, (_, index) => ({ source: 'golf', id: String(index + 1) }));
  return { collector, observation, event };
}

test('resolver preserves the original rate-limit error and retry interval', async () => {
  const { collector, observation, event } = streamedCase(1);
  const rateLimit = new SourceFetchError('http-429', 3_600_000);
  await assert.rejects(
    collector.resolvePlayers('401892458', observation, JSON.stringify(event), new AbortController().signal,
      async () => { throw rateLimit; }),
    error => error === rateLimit && error.retryAfterMs === 3_600_000,
  );
});

test('malformed streamed JSON aborts three pending sibling reads and settles promptly', async () => {
  const { collector, observation, event } = streamedCase(4);
  let started = 0,canceled = 0;
  const startedAt = Date.now();
  await assert.rejects(collector.resolvePlayers('401892458', observation, JSON.stringify(event), AbortSignal.timeout(2_000),
    async (_url, signal) => {
      if (started++ === 0) return '{broken-json';
      return new Promise<string>((_resolve, reject) => {
        const cancel = () => { canceled++; reject(signal.reason); };
        if (signal.aborted) cancel();else signal.addEventListener('abort', cancel, { once: true });
      });
    }),error => error instanceof Error && error.message === 'parser-changed');
  assert.equal(started,4);assert.equal(canceled,3);assert.ok(Date.now()-startedAt<2_000);
});

test('an invalid streamed row keeps valid source siblings instead of canceling their reads',async()=>{
  const {collector,observation,event}=streamedCase(4);
  let started=0;
  const players=await collector.resolvePlayers('401892458',observation,JSON.stringify(event),AbortSignal.timeout(2_000),async()=>{
    const id=String(++started);
    return JSON.stringify([{id,source:'golf',streamNo:id==='1'?0:100,embedUrl:'https://embed.st/embed/golf/'+id+'/'+(id==='1'?1:100)}]);
  });
  assert.equal(started,4);assert.equal(players.length,3);
  assert.deepEqual(players.map(player=>player.locator.provider==='catalog-stream'?player.locator.sourceId:null),['2','3','4']);
  assert.ok(players.every(player=>player.locator.provider==='catalog-stream'&&player.locator.streamNo===100));
});
