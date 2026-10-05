import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compatiblePlayers,enrichObservation} from '../lib/football/adapters/sources.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';
import type {Observation} from '../lib/football/shared.ts';

const start='2026-10-03T18:00:00Z';
const server='https://fxtrend.st/event/live_cfb_ball-state-toledo-live-streaming-663656976/vector/1';
const published=[['vector/1','Vector 1'],['vertex/1','Vertex 1'],['vertex/2','Vertex 2'],['foxtrot/1','Relay A1']];
function fixture(sourceId:'methstreams'|'crackstreams-st') {
  const url=`https://${sourceId==='methstreams'?'methstreams':'crackstreams'}.st/event/ball-state-vs-toledo`;
  const observation:Observation={id:sourceId,sourceId,url,title:'Ball State Cardinals vs Toledo Rockets',
    league:'ncaaf',teams:['Ball State Cardinals','Toledo Rockets'],kickoff:Date.parse(start),rawTime:start,observedAt:Date.parse(start),parserVersion:2};
  const metadata={'@type':'SportsEvent',url,name:observation.title,startDate:start,
    homeTeam:{name:'Ball State Cardinals'},awayTeam:{name:'Toledo Rockets'},offers:{price:'0'}};
  const html=`<link rel="canonical" href="${url}"><meta property="og:url" content="${url}">
    <script type="application/ld+json">${JSON.stringify(metadata)}</script><time datetime="${start}"></time>
    ${published.map(([route,label])=>`<a class="sl-row" href="${server.replace('vector/1',route)}" aria-label="Watch ${observation.title} on ${label} — opens the player in a new tab"><span class="sl-nm">${label}</span></a>`).join('')}`;
  return {observation,html};
}
test('Methstreams and Crackstreams ST extract their published free channel rows',()=>{
  for(const sourceId of ['methstreams','crackstreams-st'] as const){
    const {observation,html}=fixture(sourceId);
    const rows=compatiblePlayers('ncaaf-401866431',enrichObservation(observation,html),html);
    assert.deepEqual(rows.map(row=>row.locator),published.map(([route])=>({provider:'event-page',gameId:'ncaaf-401866431',eventUrl:observation.url,serverUrl:server.replace('vector/1',route)})));
    assert.equal(validEventPagePair(observation.url,server),true);
  }
});
test('channel rows reject mismatched event metadata and lookalike hosts',()=>{
  const {observation,html}=fixture('methstreams');
  const variants=[html.replace('"startDate":"'+start+'"','"startDate":"2026-10-04T18:00:00Z"'),
    html.replace('"name":"Ball State Cardinals vs Toledo Rockets"','"name":"Other Game"'),
    html.replace('"url":"'+observation.url+'"','"url":"https://methstreams.st/event/other-game"'),
    html.replace('property="og:url"','property="og:other"'),
    html.replace('"homeTeam":{"name":"Ball State Cardinals"}','"homeTeam":{"name":"Other Team"}'),
    html.replaceAll('fxtrend.st/','fxtrend.st.attacker.test/'),html.replaceAll('Watch Ball State Cardinals vs Toledo Rockets on','Watch Another Game on'),
    html.replace('rel="canonical" href="'+observation.url+'"','rel="canonical" href="https://methstreams.st/event/other-game"')];
  for(const changed of variants) assert.deepEqual(compatiblePlayers('ncaaf-401866431',observation,changed),[]);
  for(const changed of [html.replace('"price":"0"','"price":"5"'),
    html.replaceAll('class="sl-row"','class="sl-row premium"'),
    html.replaceAll('class="sl-row"','class="sl-row" data-paid="true"'),
    `<div class="premium">${html}</div>`])
    assert.deepEqual(compatiblePlayers('ncaaf-401866431',observation,changed).map(row=>row.locator.provider==='event-page'?row.locator.serverUrl:null),
      published.map(([route])=>server.replace('vector/1',route)));
  assert.deepEqual(compatiblePlayers('ncaaf-401866431',{...observation,url:observation.url.replace('methstreams.st','crackstreams.st')},html),[]);
  for(const changed of [server.replace('https:','http:'),server+'?token=x',server.replace('/vector/1','/vector/0'),server.replace('/vector/1','/unknown/1')])
    assert.equal(validEventPagePair(observation.url,changed),false);
});

test('dated m-event pages retain the exact main and channel routes published for that matchup',()=>{
  const slug='m-florida-gators-vs-missouri-tigers-1003';
  const title='Missouri Tigers vs Florida Gators';
  const routes=['','/core/1','/core/2','/core/3','/core/4','/vector/1','/vector/2','/vertex/1','/vertex/2','/foxtrot/1'];
  const labels=['Main 1','Core 1','Core 2','Core 3','Core 4','Vector 1','Vector 2','Vertex 1','Vertex 2','Relay A1'];
  for(const sourceId of ['methstreams','crackstreams-st'] as const){
    const url=`https://${sourceId==='methstreams'?'methstreams':'crackstreams'}.st/event/${slug}`;
    const kickoff='2026-10-03T19:30:00Z';
    const observation:Observation={id:sourceId,sourceId,url,title,league:'ncaaf',teams:['Missouri Tigers','Florida Gators'],
      kickoff:Date.parse(kickoff),rawTime:kickoff,observedAt:Date.parse(kickoff),parserVersion:2};
    const html=`<link rel="canonical" href="${url}"><meta property="og:url" content="${url}">
      <script type="application/ld+json">${JSON.stringify({'@type':'SportsEvent',url,name:title,startDate:kickoff,
        homeTeam:{name:'Missouri Tigers'},awayTeam:{name:'Florida Gators'},offers:{price:'0'}})}</script>
      ${routes.map((route,index)=>`<a class="sl-row" href="https://fxtrend.st/event/${slug}${route}" aria-label="Watch ${title} on ${labels[index]} — opens the player in a new tab"><span class="sl-nm">${labels[index]}</span></a>`).join('')}`;
    assert.deepEqual(compatiblePlayers('ncaaf-401856712',observation,html).map(row=>row.locator),routes.map(route=>({
      provider:'event-page',gameId:'ncaaf-401856712',eventUrl:url,serverUrl:`https://fxtrend.st/event/${slug}${route}`})));
    for(const route of routes) assert.equal(validEventPagePair(url,`https://fxtrend.st/event/m-other-game-1003${route}`),false);
    assert.equal(validEventPagePair(url,`https://fxtrend.st/event/${slug}/nexus/1`),false);
  }
});
