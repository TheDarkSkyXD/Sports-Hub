import assert from 'node:assert/strict';
import test from 'node:test';
import { matchObservation } from '../lib/football/domain/matching.ts';
import { GameSchema, isMatchupGame } from '../lib/football/shared.ts';
import type { League, Observation } from '../lib/football/shared.ts';
import { parseScoreboard } from '../lib/sunday.ts';

const kickoff = Date.parse('2026-10-11T17:00:00Z');
const observation: Observation = {
  id: 'buffstream-nfl-washington',
  sourceId: 'buffstream-nfl',
  url: 'https://ms.buffstream.io/nfl-streams/washington-redskins-live-stream',
  title: 'New York Giants vs Washington Redskins',
  league: 'nfl',
  teams: ['New York Giants', 'Washington Redskins'],
  kickoff,
  rawTime: '2026-10-11T17:00:00Z',
  observedAt: kickoff,
  parserVersion: 3,
};

function scoreboard({ washingtonId = '28', washingtonHome = true }: {
  washingtonId?: string | null;
  washingtonHome?: boolean;
} = {}) {
  return {
    events: [{
      id: '401872988',
      date: '2026-10-11T17:00:00Z',
      name: washingtonHome ? 'New York Giants at Washington Commanders' : 'Washington Commanders at New York Giants',
      status: { type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false, shortDetail: '10/11 - 1:00 PM EDT' } },
      competitions: [{ competitors: [{
        homeAway: washingtonHome ? 'home' : 'away',
        score: '0',
        team: {
          id: washingtonId,
          displayName: 'Washington Commanders',
          location: 'Washington',
          shortDisplayName: 'Commanders',
          name: 'Commanders',
          abbreviation: 'WSH',
          color: '5a1414',
        },
      }, {
        homeAway: washingtonHome ? 'away' : 'home',
        score: '0',
        team: {
          id: '19',
          displayName: 'New York Giants',
          location: 'New York',
          shortDisplayName: 'Giants',
          name: 'Giants',
          abbreviation: 'NYG',
          color: '003c7f',
        },
      }] }],
    }],
  };
}

test('a historical Washington source label matches the current NFL franchise in either home or away position', () => {
  for (const washingtonHome of [true, false]) {
    const game = GameSchema.parse(parseScoreboard(scoreboard({ washingtonHome }), 'nfl')[0]);
    assert.ok(isMatchupGame(game));
    assert.deepEqual(matchObservation(observation, [game], kickoff), { kind: 'matched', gameId: '401872988' });
    const washington = washingtonHome ? game.home : game.away;
    assert.equal(washington.name, 'Washington Commanders');
    assert.equal(washington.short, 'Commanders');
    assert.equal(washington.abbreviation, 'WSH');
  }
});

test('Washington historical aliases do not apply to another or missing NFL team identity', () => {
  for (const washingtonId of ['27', null]) {
    const game = GameSchema.parse(parseScoreboard(scoreboard({ washingtonId }), 'nfl')[0]);
    assert.deepEqual(matchObservation(observation, [game], kickoff), {
      kind: 'unmatched', reason: 'unknown-teams', possibleGameIds: [],
    });
  }
});

test('the same ESPN raw team ID in another league cannot inherit an NFL historical alias', () => {
  const leagues: League[] = ['ncaaf', 'nba', 'wnba', 'nhl', 'mlb'];
  for (const league of leagues) {
    const game = GameSchema.parse(parseScoreboard(scoreboard(), league)[0]);
    assert.deepEqual(matchObservation({ ...observation, league }, [game], kickoff), {
      kind: 'unmatched', reason: 'unknown-teams', possibleGameIds: [],
    });
  }
});

test('historical NFL names still require the source kickoff to agree with the official game', () => {
  const game = GameSchema.parse(parseScoreboard(scoreboard(), 'nfl')[0]);
  assert.deepEqual(matchObservation({ ...observation, kickoff: kickoff + 24 * 60 * 60_000 }, [game], kickoff), {
    kind: 'unmatched', reason: 'conflicting-date', possibleGameIds: ['401872988'],
  });
});
