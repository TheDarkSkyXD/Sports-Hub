import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { sourceFailure } from '../lib/football/domain/source-policy.ts';
import { SourceAttemptSchema } from '../lib/football/shared.ts';

test('HTTP access denials and oversized pages retain their collector failure reason', () => {
  assert.equal(sourceFailure(new Error('http-403')), 'blocked');
  assert.equal(sourceFailure(new Error('response-too-large')), 'response-too-large');
  assert.equal(sourceFailure(new Error('http-404')), 'not-found');
  assert.equal(sourceFailure(new Error('http-503')), 'upstream-error');
  assert.equal(sourceFailure(new Error('fetch failed')), 'network-unavailable');
  assert.equal(SourceAttemptSchema.safeParse({at:1,outcome:'failed',failure:'response-too-large'}).success, true);
});

test('browser collection failures retain their concrete cause', () => {
  for (const [message,expected] of [
    ['source-page-challenge','blocked'],
    ['source-page-capacity','collector-busy'],
    ['source-page-timeout','timed-out'],
    ['source-page-network-error','network-unavailable'],
    ['source-page-closed','network-unavailable'],
    ['source-page-window-closed','network-unavailable'],
    ['source-page-response-too-large','response-too-large'],
    ['source-page-page-changed','invalid-response'],
    ['source-page-changed','invalid-response'],
    ['source-page-invalid-response','invalid-response'],
    ['source-page-unsupported-address','unsupported-address'],
  ]) assert.equal(sourceFailure(new Error(message)),expected,message);
});

test('legacy collector errors use the same precise classification when the store reopens', () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-transport-failures-'));
  const path = join(directory, 'state.sqlite');
  try {
    new FootballStore(path).close();
    const db = new DatabaseSync(path);
    try {
      const insert = db.prepare('INSERT INTO sources (id,payload) VALUES (?,?)');
      insert.run('dudestream-nhl', JSON.stringify({at:1,outcome:'failed',error:'http-403'}));
      insert.run('sportsurgei-mlb', JSON.stringify({at:1,outcome:'failed',error:'response-too-large'}));
    } finally { db.close(); }
    const store = new FootballStore(path);
    try {
      const attempts = store.sourceAttempts();
      assert.equal(attempts['dudestream-nhl'].failure, 'blocked');
      assert.equal(attempts['sportsurgei-mlb'].failure, 'response-too-large');
    } finally { store.close(); }
  } finally { rmSync(directory, {recursive:true,force:true}); }
});
