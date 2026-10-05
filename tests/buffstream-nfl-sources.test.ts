import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parseListings, SOURCES} from '../lib/football/adapters/sources.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import type {Game} from '../lib/football/shared.ts';

const now = Date.parse('2026-10-04T17:00:00Z');

test('Buffstream NFL rows expose both published feeds without inventing a date', () => {
  const source = SOURCES.find(item => item.id === 'buffstream-nfl');
  assert.ok(source);
  const html = `<table><tr>
    <td><a href="http://ms.buffstream.io/nfl-streams/indianapolis-colts-live-stream">Indianapolis Colts Live Stream</a></td>
    <td>09:30 am ET</td>
    <td><a href="http://ms.buffstream.io/nfl-streams/washington-redskins-live-stream">Washington Redskins Live Stream</a></td>
  </tr></table>`;
  const result = parseListings(source,html,now);
  assert.equal(result.outcome,'parsed');
  assert.deepEqual(result.observations.map(item => item.url),[
    'https://ms.buffstream.io/nfl-streams/indianapolis-colts-live-stream',
    'https://ms.buffstream.io/nfl-streams/washington-redskins-live-stream',
  ]);
  for (const observation of result.observations) {
    assert.deepEqual(observation.teams,['Indianapolis Colts','Washington Redskins']);
    assert.equal(observation.league,'nfl');
    assert.equal(observation.kickoff,null);
  }
});

test('Buffstream NFL retains the date published on its event', () => {
  const source = SOURCES.find(item => item.id === 'buffstream-nfl');
  assert.ok(source);
  const html = '<a href="https://ms.buffstream.io/nfl-streams/buffalo-bills-live-stream">Buffalo Bills vs New England Patriots2026-10-03, Saturday - 01:00 pm ET</a>';
  const result = parseListings(source,html,now);
  assert.equal(result.outcome,'parsed');
  assert.deepEqual(result.observations[0].teams,['Buffalo Bills','New England Patriots']);
  assert.equal(result.observations[0].kickoff,Date.parse('2026-10-03T17:00:00Z'));
});

test('Crackstreams NFL registry parses and matches its published live and upcoming events', () => {
  const registered = SOURCES.filter(item => item.id === 'crackstreams-nfl' ||
    'name' in item && item.name === 'Crackstreams NFL');
  assert.deepEqual(registered.map(item => item.id),['crackstreams-st']);
  const source = registered[0];
  const html = readFileSync(new URL('./fixtures/crackstreams-st-nfl-2026-10-04.html',import.meta.url),'utf8');
  const at = Date.parse('2026-10-05T02:30:00Z');
  const observations = parseListings(source,html,at).observations;
  const live = observations.find(item => item.teams?.includes('Detroit Lions'));
  const upcoming = observations.find(item => item.teams?.includes('Atlanta Falcons'));
  assert.ok(live);
  assert.ok(upcoming);
  assert.equal(live.url,'https://crackstreams.st/event/m-detroit-lions-vs-carolina-panthers-1005');
  assert.equal(live.kickoff,Date.parse('2026-10-05T00:20:00Z'));
  assert.equal(upcoming.url,'https://crackstreams.st/event/m-atlanta-falcons-vs-new-orleans-saints-1006');
  assert.equal(upcoming.kickoff,Date.parse('2026-10-06T00:15:00Z'));
  const team = (name:string,id:string) => ({name,id,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
  const game:Game = {id:'401872978',league:'nfl',name:'Detroit Lions at Carolina Panthers',
    date:'2026-10-05T00:20:00Z',home:team('Carolina Panthers','espn:nfl:29'),
    away:team('Detroit Lions','espn:nfl:8'),status:'in',lifecycle:'live',detail:'Q3',redzone:false};
  const nextGame:Game = {id:'401872979',league:'nfl',name:'Atlanta Falcons at New Orleans Saints',
    date:'2026-10-06T00:15:00Z',home:team('New Orleans Saints','espn:nfl:18'),
    away:team('Atlanta Falcons','espn:nfl:1'),status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false};
  assert.deepEqual(matchObservation(live,[game],at),{kind:'matched',gameId:game.id});
  assert.deepEqual(matchObservation(upcoming,[nextGame],at),{kind:'matched',gameId:nextGame.id});
});

test('Buffstream NFL does not upgrade links outside the exact public route', () => {
  const source = SOURCES.find(item => item.id === 'buffstream-nfl');
  assert.ok(source);
  for (const url of [
    'http://ms.buffstream.io.evil.test/nfl-streams/indianapolis-colts-live-stream',
    'http://user@ms.buffstream.io/nfl-streams/indianapolis-colts-live-stream',
    'http://ms.buffstream.io:8080/nfl-streams/indianapolis-colts-live-stream',
    'http://ms.buffstream.io/nfl-streams/indianapolis-colts-live-stream?paid=true',
    'http://ms.buffstream.io/other/indianapolis-colts-live-stream',
  ]) {
    assert.equal(parseListings(source,`<a href="${url}">Indianapolis Colts vs Washington Redskins</a>`,now).observations.length,0);
  }
});
