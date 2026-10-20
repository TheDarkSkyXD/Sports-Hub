import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { pipelineView } from '../native/collector/bridge.cjs';

const corpus = z.object({ cases: z.array(z.object({
  operation: z.string(), input: z.unknown(), expected: z.unknown(),
})) }).parse(JSON.parse(readFileSync(new URL('./fixtures/rust-pipeline-views.json', import.meta.url), 'utf8')));

test('Rust preserves full and compact inventory and catalog publication results', () => {
  for (const [index, entry] of corpus.cases.entries()) {
    const actual: unknown = JSON.parse(pipelineView(entry.operation, JSON.stringify(entry.input)));
    assert.deepEqual(actual, entry.expected, `View case ${index}, ${entry.operation}`);
  }
});
