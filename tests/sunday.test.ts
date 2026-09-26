import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScoreboard, parsePlayers, validFeedUrl, priority } from '../lib/sunday.ts';
import type { Game } from '../lib/sunday.ts';

const team = (name:string) => ({name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const game:Game = {id:'1',league:'nfl',name:'Away at Home',home:team('Home'),away:team('Away'),status:'in',detail:'Q1',redzone:false};

test('scoreboard keeps ESPN scores and home/away identity',() => {
  const data = {events:[{id:'9',name:'Away at Home',status:{type:{state:'in',shortDetail:'Q2'}},competitions:[{competitors:[
    {id:'a',homeAway:'away',team:{id:'2',displayName:'Away',name:'Away',abbreviation:'AWY',color:'ffffff'}},
    {id:'h',homeAway:'home',score:'7',team:{id:'1',displayName:'Home',name:'Home',abbreviation:'HME',color:'000000'}},
  ],situation:{isRedZone:true,possession:'h'}}]}]};
  const [parsed] = parseScoreboard(data);
  assert.equal(parsed.id,'9');
  assert.equal(parsed.home.id,'espn:nfl:1');
  assert.equal(parsed.home.score,'7');
  assert.equal(parsed.away.score,null);
  assert.equal(parsed.redzone,true);
  assert.equal(parsed.possession,'HME');
  assert.throws(() => parseScoreboard({error:'blocked'}));
});

test('a final is recognized only from ESPN completed state',() => {
  const event = {id:'397359440',name:'Brown at Harvard',date:'2026-09-26T16:00:00Z',status:{type:{state:'post',name:'STATUS_FINAL',completed:true}},competitions:[{competitors:[
    {id:'b',homeAway:'away',team:{id:'1',displayName:'Brown Bears',shortDisplayName:'Brown',abbreviation:'BRWN'}},
    {id:'h',homeAway:'home',team:{id:'2',displayName:'Harvard Crimson',shortDisplayName:'Harvard',abbreviation:'HARV'}},
  ]}]};
  const [parsed] = parseScoreboard({events:[event]},'ncaaf');
  assert.equal(parsed.id,'ncaaf-397359440');
  assert.equal(parsed.lifecycle,'final');
  assert.equal(parsed.away.short,'Brown');
  event.status.type.completed=false;
  assert.equal(parseScoreboard({events:[event]},'ncaaf')[0].lifecycle,'unknown');
});

test('player extraction accepts only the known embed host and deduplicates backup IDs',() => {
  const html = '<iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe><button onclick="changeStream(456)"></button><button onclick="changeStream(123)"></button>';
  assert.deepEqual(parsePlayers(html).map(player => player.id),['123','456']);
  assert.deepEqual(parsePlayers(html.replace('gooz.aapmains.net','attacker.test')),[]);
});

test('manual feed accepts HTTPS and loopback video addresses only',() => {
  for (const bad of ['javascript:alert(1)','data:video/mp4;base64,abc','file:///etc/passwd','http://remote.example/video.mp4','https://user:pass@example.com/a.mp4']) assert.equal(validFeedUrl(bad),null);
  assert.equal(validFeedUrl('https://example.com/live.m3u8'),'https://example.com/live.m3u8');
  assert.equal(validFeedUrl('http://localhost:3001/test.mp4'),'http://localhost:3001/test.mp4');
});

test('red-zone live games rank ahead of ordinary live and scheduled games',() => {
  assert.ok(priority({...game,redzone:true}) > priority(game));
  assert.ok(priority(game) > priority({...game,status:'pre'}));
});
