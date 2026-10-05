import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseListings,SOURCES} from '../lib/football/adapters/sources.ts';

test('VIPBox college schedule reports its published no-match state as empty', () => {
  const source = SOURCES.find(item=>item.id==='vipbox-cfb');
  assert.ok(source);
  const html = `<meta property="og:url" content="https://vipbox.fm/ncaaf-schedule">
    <h1>VIPBox NCAAF Streaming Online</h1>
    <h3 class="card-header text-center">No Match's Today for NCAAF</h3>
    <div class="card-body">Not able to find any match/event on NCAAF today.</div>
    <script>const siteConfig={"loaded_page":"schedule","is_cat_dom":false};</script>`;
  assert.deepEqual(parseListings(source,html,Date.parse('2026-10-05T23:01:00Z')),
    {observations:[],outcome:'empty'});
});

test('VIPBox college empty marker does not mask unknown markup or another schedule', () => {
  const college = SOURCES.find(item=>item.id==='vipbox-cfb');
  const nfl = SOURCES.find(item=>item.id==='vipbox-nfl');
  assert.ok(college);
  assert.ok(nfl);
  const at = Date.parse('2026-10-05T23:01:00Z');
  assert.equal(parseListings(college,'<main>Schedule unavailable</main>',at).outcome,'parser-changed');
  assert.equal(parseListings(college,"<h3>No Match's Today for NCAAF</h3>",at).outcome,'parser-changed');
  assert.equal(parseListings(nfl,"<h3>No Match's Today for NCAAF</h3>",at).outcome,'parser-changed');
});
