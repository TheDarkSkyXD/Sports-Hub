import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scopedSourceLinks } from '../components/source-inventory-view.ts';
import type { SourcesSnapshot } from '../lib/football/shared.ts';

const links: SourcesSnapshot['sources'][number]['links'] = [
  { title: 'Dana Whites Contender Series', url: 'https://example.com/contender', gameId: null, league: 'ufc',
    observedAt: 1000, freshness: 'fresh', evidence: { kind: 'unmatched', reason: 'unverified-kickoff' } },
  { title: 'NBA game', url: 'https://example.com/nba', gameId: null, league: 'nba',
    observedAt: 1000, freshness: 'fresh', evidence: { kind: 'unmatched', reason: 'unverified-kickoff' } },
  { title: 'NFL Network 24/7', url: 'https://example.com/channel', gameId: null, league: null,
    observedAt: 1000, freshness: 'fresh', evidence: { kind: 'unmatched', reason: 'not-a-matchup' } },
];

test('category links remain visible without a schedule match while continuous streams stay unclassified', () => {
  const result = scopedSourceLinks(links, new Map(), 'all');
  assert.deepEqual(result.links.map(link => link.title), ['Dana Whites Contender Series', 'NBA game']);
  assert.deepEqual(result.unclassifiedLinks.map(link => link.title), ['NFL Network 24/7']);
  const ufc = scopedSourceLinks(links, new Map(), 'ufc');
  assert.deepEqual(ufc.links.map(link => link.title), ['Dana Whites Contender Series']);
  assert.deepEqual(ufc.unclassifiedLinks.map(link => link.title), ['NFL Network 24/7']);
});

test('snapshot categories classify links even when board branding is absent', () => {
  const result = scopedSourceLinks([{ ...links[0], gameId: 'ufc-123' }], new Map(), 'ufc');
  assert.deepEqual(result.links.map(link => link.title), ['Dana Whites Contender Series']);
  assert.deepEqual(result.unclassifiedLinks, []);
});

test('standalone continuous streams stay unclassified even with a provider category', () => {
  const result = scopedSourceLinks([{ ...links[2], league: 'nfl' }], new Map(), 'nfl');
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.unclassifiedLinks.map(link => link.title), ['NFL Network 24/7']);
});

test('events outside supported categories remain accessible without becoming unclassified streams', () => {
  const event = { ...links[2], title: 'Montreal Alouettes vs Saskatchewan Roughriders', url: 'https://example.com/cfl' };
  const result = scopedSourceLinks([...links, event], new Map(), 'all');
  assert.deepEqual(result.unclassifiedLinks.map(link => link.title), ['NFL Network 24/7']);
  assert.deepEqual(result.otherEventLinks.map(link => link.title), [event.title]);
  const ufc = scopedSourceLinks([...links, event], new Map(), 'ufc');
  assert.deepEqual(ufc.otherEventLinks, []);
});
