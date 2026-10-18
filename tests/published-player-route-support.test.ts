import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {compatiblePlayers,createFixtureCollector} from '../lib/football/adapters/sources.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';
import {SOURCE_REGISTRY} from '../lib/football/source-registry.ts';
import type {Observation} from '../lib/football/shared.ts';

const cases=z.array(z.object({sourceId:z.string(),eventUrl:z.string().url(),title:z.string(),
  teams:z.tuple([z.string(),z.string()]),urls:z.array(z.string().url())})).parse(JSON.parse(
    readFileSync(new URL('./fixtures/published-player-routes.json',import.meta.url),'utf8')));

for(const fixture of cases) {
  test(`${fixture.sourceId} admits its captured published player routes through native and playback policies`,()=>{
    for(const url of fixture.urls) {
      assert.equal(validEventPagePair(fixture.eventUrl,url),true,url);
      const row:Observation={id:`${fixture.sourceId}:captured`,sourceId:fixture.sourceId,url:fixture.eventUrl,
        title:fixture.title,teams:fixture.teams,league:'nhl',kickoff:1791824400000,rawTime:'2026-10-12T17:00:00Z',
        observedAt:1791824400000,parserVersion:3};
      const html=`<link rel="canonical" href="${fixture.eventUrl}"><iframe src="${url.replaceAll('&','&amp;')}"></iframe>`;
      const players=compatiblePlayers('nhl-401892485',row,html);
      assert.equal(players.length,1,url);
      const locator=players[0].locator;
      assert.equal(locator.provider,'event-page');
      if(locator.provider==='event-page')assert.equal(locator.serverUrl,url);
    }
  });
}

test('source player routes reject unknown hosts, unrelated matchups and malformed provider paths',()=>{
  const event='https://sportsurgei.is/Sabres-vs-Panthers/73180';
  assert.equal(validEventPagePair(event,'https://alphastreams.mom/2026/10/12/sabres-vs-panthers/'),true);
  for(const url of ['https://alphastreams.mom.evil.test/2026/10/12/sabres-vs-panthers/',
    'https://alphastreams.mom/2026/10/12/rangers-vs-canucks/','https://example.com/2026/10/12/sabres-vs-panthers/',
    'http://alphastreams.mom/2026/10/12/sabres-vs-panthers/','https://goomdstea.click/stream.php?ch=11&redirect=1',
    'https://poscihub.ru/?post=abc','https://topstream.help/?p=0'])assert.equal(validEventPagePair(event,url),false,url);
  assert.equal(validEventPagePair('https://iohit.st/event/buffalo-sabres-vs-florida-panthers-2591571',
    'https://embed.st/embed-noads/admin/ppv-rangers-vs-canucks/1#player=clappr'),false);
  assert.equal(validEventPagePair('https://trend48.st/event/m-florida-panthers-vs-buffalo-sabres-1012',
    'https://trendy48.site/admin/s3olxy90-9585'),false);
  assert.equal(validEventPagePair('https://ihdstreams.top/watch/florida-panthers-at-buffalo-sabres',
    'https://ihdstreams.top/embed/nhl/ch1.php?redirect=https://example.com'),false);
});

test('Buffstream MotoGP reads its canonical catalog without a cross-host redirect',async()=>{
  const source=SOURCE_REGISTRY.find(source=>source.id==='buffstream-motogp');
  assert.ok(source);
  const collector=createFixtureCollector();
  collector.enqueueFixture({url:'https://ms.buffstream.io/motor-streams-live-26',body:'<h1>Motor Stream and Schedule</h1>'});
  assert.equal(await collector.readHtml(source.url,new AbortController().signal),'<h1>Motor Stream and Schedule</h1>');
  assert.deepEqual(collector.fixtureRequests().map(request=>request.url),['https://ms.buffstream.io/motor-streams-live-26']);
});
