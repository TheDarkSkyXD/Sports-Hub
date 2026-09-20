import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesGameSearch } from '../lib/game-discovery.ts';
import type { Game } from '../lib/sunday.ts';

const game: Game = {
  id: '1', name: 'Minnesota Vikings at Chicago Bears', status: 'in', detail: 'Q2', redzone: false,
  away: { name: 'Minnesota Vikings', short: 'Vikings', abbreviation: 'MIN', color: '112233', score: '7' },
  home: { name: 'Chicago Bears', short: 'Bears', abbreviation: 'CHI', color: '445566', score: '14' },
};

test('blank searches and matchup connectors leave games visible', () => {
  for (const query of ['', '  \t\n ', 'vs.', '@', ' at ', 'vs / @']) {
    assert.equal(matchesGameSearch(game, query), true, query);
  }
});

test('team search tolerates pasted whitespace, case, punctuation, and either matchup order', () => {
  for (const query of ['  Bears  ', 'VIKINGS', 'MIN CHI', 'chi min', 'Vikings vs. Bears', 'MIN @ CHI', 'Bears / Vikings', 'Chicago   Minnesota', 'vik bears']) {
    assert.equal(matchesGameSearch(game, query), true, query);
  }
  assert.equal(matchesGameSearch(game, 'MIN BUF'), false, 'Every requested team must appear in the matchup');
  assert.equal(matchesGameSearch(game, 'Packers'), false);
});

test('search includes team fields when a provider supplies a generic game title', () => {
  const listing = { ...game, name: 'Sunday early window' };
  assert.equal(matchesGameSearch(listing, 'Minnesota vs Chicago'), true);
  assert.equal(matchesGameSearch(listing, 'Bears'), true);
  assert.equal(matchesGameSearch(listing, 'MIN CHI'), true);
});

test('dotted abbreviations and numeric team names remain searchable', () => {
  const matchup: Game = {
    ...game, name: 'Kansas City Chiefs at San Francisco 49ers',
    away: { ...game.away, name: 'Kansas City Chiefs', short: 'Chiefs', abbreviation: 'KC' },
    home: { ...game.home, name: 'San Francisco 49ers', short: '49ers', abbreviation: 'SF' },
  };
  assert.equal(matchesGameSearch(matchup, 'K.C. vs. S.F.'), true);
  assert.equal(matchesGameSearch(matchup, '49ers / Chiefs'), true);
  assert.equal(matchesGameSearch(matchup, '49 kansas'), true);
  assert.equal(matchesGameSearch(matchup, 'K.C. vs. MIN'), false);
  assert.equal(matchesGameSearch(matchup, 'CHI'), false, 'CHI means Chicago, not a Chiefs name prefix');
  assert.equal(matchesGameSearch(matchup, 'chief'), true);
});

test('canonical abbreviations match exact teams instead of fragments of unrelated names', () => {
  assert.equal(matchesGameSearch(game, 'CHI'), true);
  assert.equal(matchesGameSearch(game, 'chi'), true);
  assert.equal(matchesGameSearch(game, 'NE'), false, 'NE must not match the middle of Minnesota');
  assert.equal(matchesGameSearch(game, 'n.e.'), false);
  const patriots = { ...game, name: 'New England Patriots at Chicago Bears', away: { ...game.away, name: 'New England Patriots', short: 'Patriots', abbreviation: 'NE' } };
  assert.equal(matchesGameSearch(patriots, 'NE'), true);
  assert.equal(matchesGameSearch(patriots, 'n.e. @ c.h.i.'), true);
  assert.equal(matchesGameSearch(patriots, 'new eng'), true);
});

test('canonical team names and actual provider abbreviations both work in source-only listings', () => {
  const fallback = { ...game, away: { ...game.away, abbreviation: 'MV' }, home: { ...game.home, abbreviation: 'CB' } };
  assert.equal(matchesGameSearch(fallback, 'MIN CHI'), true);
  assert.equal(matchesGameSearch(fallback, 'MV CB'), true);
  assert.equal(matchesGameSearch(fallback, 'CHI MV'), true);
  assert.equal(matchesGameSearch(fallback, 'NE CB'), false);
});

test('short code ambiguity is resolved without losing ordinary name prefixes', () => {
  const matchup: Game = {
    ...game, name: 'Arizona Cardinals at New Orleans Saints',
    away: { ...game.away, name: 'Arizona Cardinals', short: 'Cardinals', abbreviation: 'ARI' },
    home: { ...game.home, name: 'New Orleans Saints', short: 'Saints', abbreviation: 'NO' },
  };
  assert.equal(matchesGameSearch(matchup, 'CAR'), false, 'CAR means Carolina, not Cardinals');
  assert.equal(matchesGameSearch(matchup, 'card'), true);
  assert.equal(matchesGameSearch(matchup, 'ariz card'), true);
  assert.equal(matchesGameSearch(matchup, 'no'), true);
  assert.equal(matchesGameSearch(matchup, 'ne'), false);
  assert.equal(matchesGameSearch(matchup, 'new orl'), true);
});

test('Washington code variants work with canonical names and provider abbreviations', () => {
  const commanders = { ...game, name: 'Washington Commanders at Chicago Bears', away: { ...game.away, name: 'Washington Commanders', short: 'Commanders', abbreviation: 'WAS' } };
  assert.equal(matchesGameSearch(commanders, 'WAS'), true);
  assert.equal(matchesGameSearch(commanders, 'WSH'), true);
  assert.equal(matchesGameSearch(commanders, 'wash com'), true);
});
