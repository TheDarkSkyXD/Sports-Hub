import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {z} from 'zod';
import {compatiblePlayers} from '../lib/football/adapters/sources.ts';
import type {CandidateLocator,Observation} from '../lib/football/shared.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';
import {eventPageProbeIdentity,eventPageProvider} from '../lib/playback/providers/event-page.ts';

const slug='m-philadelphia-eagles-vs-jacksonville-jaguars-1011';
const title='Jacksonville Jaguars vs Philadelphia Eagles';
const kickoff='2026-10-11T13:30:00+00:00';
const routes=['main/1','main/2','core/1','core/2','vertex/1','vertex/2','hotel/1'];
const labels=['Main 1','Main 2','Core 1','Core 2','Vertex 1','Vertex 2','Relay A1'];
const server=`https://foxiy.st/event/${slug}/main/1`;
const locator:Extract<CandidateLocator,{provider:'event-page'}>={provider:'event-page',gameId:'401872981',
  eventUrl:`https://methstreams.st/event/${slug}`,serverUrl:server};

test('current Methstreams and Crackstreams details retain their seven published Foxiy players',()=>{
  for(const [sourceId,host] of [['methstreams','methstreams.st'],['crackstreams-st','crackstreams.st']] as const){
    const url=`https://${host}/event/${slug}`;
    const observation:Observation={id:`${sourceId}:current`,sourceId,url,title,league:null,
      teams:['Jacksonville Jaguars','Philadelphia Eagles'],kickoff:Date.parse(kickoff),rawTime:kickoff,
      observedAt:1791736671416,parserVersion:2};
    const metadata={'@type':'SportsEvent',name:title,url,startDate:kickoff,offers:{price:'0'},
      homeTeam:{name:'Jacksonville Jaguars'},awayTeam:{name:'Philadelphia Eagles'}};
    const body=`<link rel="canonical" href="${url}"><meta property="og:url" content="${url}">
      <script type="application/ld+json">${JSON.stringify(metadata)}</script>
      ${routes.map((route,index)=>`<a class="sl-row" href="https://foxiy.st/event/${slug}/${route}"
        aria-label="Watch ${title} on ${labels[index]} opens the player"><span class="sl-nm">${labels[index]}</span></a>`).join('')}`;
    const players=compatiblePlayers(locator.gameId,observation,body);
    assert.deepEqual(players.map(player=>player.locator.provider==='event-page'?player.locator.serverUrl:null),
      routes.map(route=>`https://foxiy.st/event/${slug}/${route}`));
    assert.deepEqual(compatiblePlayers(locator.gameId,{...observation,kickoff:Date.parse(kickoff)+86_400_000},body),[]);
    assert.deepEqual(compatiblePlayers(locator.gameId,observation,body.replaceAll('foxiy.st','foxiy.st.evil.test')),[]);
  }
});

test('Foxiy and Fxtrend player URLs keep exact event binding and reject other games and lookalikes',()=>{
  for(const host of ['foxiy.st','fxtrend.st']){
    const published=server.replace('foxiy.st',host);
    assert.equal(validEventPagePair(locator.eventUrl,published),true);
    for(const invalid of [published.replace('philadelphia-eagles','other-team'),published.replace(host,`${host}.evil.test`),
      published.replace('https:','http:'),`${published}?player=1`,`${published}#player`,
      published.replace('/main/1','/admin/1'),published.replace('/main/1','/main/0')]){
      assert.equal(validEventPagePair(locator.eventUrl,invalid),false,invalid);
    }
  }
});

test('Foxiy cannot use an unrelated game through the legacy live NFL route',()=>{
  const wrongGame='https://foxiy.st/event/live_nfl_miami-dolphins-vs-cincinnati-bengals-live-streaming-123/vector/1';
  for(const host of ['methstreams.st','crackstreams.st']){
    assert.equal(validEventPagePair(`https://${host}/event/chicago-bears-vs-green-bay-packers`,wrongGame),false);
  }
});

test('collector metadata for one game cannot admit a Foxiy live NFL player for another game',()=>{
  for(const [sourceId,host] of [['methstreams','methstreams.st'],['crackstreams-st','crackstreams.st']] as const){
    const url=`https://${host}/event/chicago-bears-vs-green-bay-packers`;
    const name='Chicago Bears vs Green Bay Packers';
    const observation:Observation={id:`${sourceId}:wrong-player`,sourceId,url,title:name,league:'nfl',
      teams:['Chicago Bears','Green Bay Packers'],kickoff:Date.parse(kickoff),rawTime:kickoff,
      observedAt:1791736671416,parserVersion:2};
    const metadata={'@type':'SportsEvent',name,url,startDate:kickoff,offers:{price:'0'},
      homeTeam:{name:'Chicago Bears'},awayTeam:{name:'Green Bay Packers'}};
    const body=`<link rel="canonical" href="${url}"><meta property="og:url" content="${url}">
      <script type="application/ld+json">${JSON.stringify(metadata)}</script>
      <a class="sl-row" href="https://foxiy.st/event/live_nfl_miami-dolphins-vs-cincinnati-bengals-live-streaming-123/vector/1"
        aria-label="Watch ${name} on Vector 1 opens the player"><span class="sl-nm">Vector 1</span></a>`;
    assert.deepEqual(compatiblePlayers(locator.gameId,observation,body),[]);
  }
});

test('both source catalogs share one probe identity for the same Foxiy server and game',()=>{
  const expected=JSON.stringify(['event-page','fxtrend',locator.gameId,server]);
  assert.equal(eventPageProbeIdentity(locator),expected);
  assert.equal(eventPageProbeIdentity({...locator,eventUrl:locator.eventUrl.replace('methstreams','crackstreams')}),expected);
  assert.notEqual(eventPageProbeIdentity({...locator,gameId:'401892905'}),expected);
  assert.notEqual(eventPageProbeIdentity({...locator,serverUrl:server.replace('/main/1','/main/2')}),expected);
  assert.notEqual(eventPageProbeIdentity({...locator,serverUrl:server.replace('foxiy.st','fxtrend.st')}),expected);
});

test('the Foxiy provider uses the existing static player path and honors cancellation before opening a browser',async()=>{
  let opened=false;
  const provider=eventPageProvider(async()=>{opened=true;return null;});
  const controller=new AbortController();
  const reason=new Error('Player request canceled');
  controller.abort(reason);
  await assert.rejects(provider.open(locator,controller.signal,'probe'),error=>error===reason);
  await assert.rejects(provider.open({...locator,serverUrl:server.replace('philadelphia-eagles','other-team')},
    controller.signal,'probe'),/Unsupported event page/);
  assert.equal(opened,false);
});

test('the observer gives only exact Foxiy and Fxtrend PPV players the existing larger frame budget',()=>{
  const observerFile=new URL('../desktop/sportsurge-observer.cjs',import.meta.url);
  const observerRequire=createRequire(observerFile);
  const entry=z.function().args(z.string()).returns(z.boolean()).parse(runInNewContext(
    `${readFileSync(observerFile,'utf8')}\nfxtrendPpvEntry;`,{
      require:(id:string)=>id==='electron'?{}:observerRequire(id),module:{exports:{}},exports:{},URL,
    }));
  for(const host of ['foxiy.st','fxtrend.st']){
    const page=`https://${host}/event/ppv-golden-state-warriors-vs-portland-trail-blazers/vertex/1`;
    assert.equal(entry(page),true);
    for(const invalid of [server.replace('foxiy.st',host),page.replace(host,`${host}.evil.test`),`${page}?player=1`,
      page.replace('/vertex/1','/admin/1')])assert.equal(entry(invalid),false);
  }
});
