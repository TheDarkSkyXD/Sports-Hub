import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativePipeline } from '../native/collector/bridge.cjs';
import { ReplySchema } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-19T18:00:00Z');

test('the Rust owner returns the public board and closes without external adapters', () => {
  const pipeline = createNativePipeline(':memory:', JSON.stringify({ sources: [], schedules: [], now: at }));
  const batch = JSON.parse(pipeline.step(JSON.stringify({
    kind: 'command', requestId: 1, value: { kind: 'board' },
  }), at));
  const reply = ReplySchema.parse(batch.replies[0].value);
  assert.equal(batch.replies[0].requestId, 1);
  assert.equal(reply.kind, 'board');
  if (reply.kind !== 'board') assert.fail('Expected the public game board');
  assert.deepEqual(reply.board.games, []);
  assert.equal(reply.board.schemaVersion, 2);
  assert.deepEqual(batch.launch, []);
  const stopped = JSON.parse(pipeline.step(JSON.stringify({
    kind: 'command', requestId: 2, value: { kind: 'stop' },
  }), at));
  assert.deepEqual(stopped.replies, [{ requestId: 2, value: { kind: 'ok' } }]);
});
