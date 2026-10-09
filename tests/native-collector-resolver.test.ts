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

test('malformed streamed responses abort three pending sibling reads and settle promptly', async () => {
  for (const invalid of ['{broken-json', JSON.stringify([{ id: '1', source: 'golf', streamNo: 0,
    embedUrl: 'https://embed.st/embed/golf/1/1' }])]) {
    const { collector, observation, event } = streamedCase(4);
    let started = 0;
    let canceled = 0;
    const startedAt = Date.now();
    await assert.rejects(
      collector.resolvePlayers('401892458', observation, JSON.stringify(event), AbortSignal.timeout(2_000),
        async (_url, signal) => {
          const index = started++;
          if (index === 0) return invalid;
          return new Promise<string>((_resolve, reject) => {
            const cancel = () => { canceled++; reject(signal.reason); };
            if (signal.aborted) cancel();
            else signal.addEventListener('abort', cancel, { once: true });
          });
        }),
      error => error instanceof Error && error.message === 'parser-changed',
    );
    assert.equal(started, 4);
    assert.equal(canceled, 3);
    assert.ok(Date.now() - startedAt < 2_000);
  }
});
