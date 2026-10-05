import assert from 'node:assert/strict';
import test from 'node:test';
import {compatiblePlayers} from '../lib/football/adapters/sources.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';
import type {Observation} from '../lib/football/shared.ts';

const kickoff='2026-10-05T00:20:00+00:00';
const routes=['main/1','main/2','core/1','core/2','vertex/1','vertex/2','hotel/1'];
const labels=['Main 1','Main 2','Core 1','Core 2','Vertex 1','Vertex 2','Relay A1'];
const name='Detroit Lions vs Carolina Panthers';

function fixture(sourceId:'methstreams'|'crackstreams-st', title=name) {
  const host=sourceId==='methstreams'?'methstreams.st':'crackstreams.st';
  const slug='m-detroit-lions-vs-carolina-panthers-1005';
  const url=`https://${host}/event/${slug}`;
  const observation:Observation={id:`${sourceId}:current`,sourceId,url,title,league:'nfl',
    teams:['Detroit Lions','Carolina Panthers'],kickoff:Date.parse(kickoff),rawTime:kickoff,
    observedAt:Date.parse(kickoff),parserVersion:2};
  const metadata={'@type':'SportsEvent',url,name,startDate:kickoff,
    performer:[{'@type':'SportsTeam',name}],offers:{price:'0'}};
  const html=(event:typeof metadata)=>`<link rel="canonical" href="${url}"><meta property="og:url" content="${url}">
    <script type="application/ld+json">${JSON.stringify(event)}</script>
    ${routes.map((route,index)=>`<a class="sl-row" href="https://fxtrend.st/event/${slug}/${route}" aria-label="Watch ${name} on ${labels[index]} — opens the player in a new tab"><span class="sl-nm">${labels[index]}</span></a>`).join('')}`;
  return {observation,metadata,html};
}

test('current Methstreams and Crackstreams ST publish all seven exact free channels',()=>{
  for(const sourceId of ['methstreams','crackstreams-st'] as const){
    const {observation,metadata,html}=fixture(sourceId,'Carolina Panthers vs Detroit Lions');
    const players=compatiblePlayers('401872978',observation,html(metadata));
    assert.deepEqual(players.map(player=>player.locator.provider==='event-page'?player.locator.serverUrl:null),
      routes.map(route=>`https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/${route}`));
    for(const route of routes)assert.equal(validEventPagePair(observation.url,
      `https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/${route}`),true);
  }
});

test('current channel rows require matching identity and published metadata',()=>{
  const {observation,metadata,html}=fixture('methstreams');
  for(const changed of [
    {...metadata,url:'https://methstreams.st/event/m-other-game-1005'},
    {...metadata,name:'Other Game'},
    {...metadata,startDate:'2026-10-06T00:20:00+00:00'},
    {...metadata,performer:[{'@type':'SportsTeam',name:'Other Game'}]},
    {...metadata,homeTeam:{name:'Other Team'},awayTeam:{name:'Carolina Panthers'}},
    {...metadata,homeTeam:{name:'Detroit Lions'}},
    {...metadata,homeTeam:'Detroit Lions',awayTeam:{name:'Carolina Panthers'}},
  ])assert.deepEqual(compatiblePlayers('401872978',observation,html(changed)),[]);
  assert.deepEqual(compatiblePlayers('401872978',observation,html(metadata).replace('property="og:url"','property="og:other"')),[]);
  assert.deepEqual(compatiblePlayers('401872978',observation,html(metadata).replace('rel="canonical"','rel="other"')),[]);
});

test('new main and hotel routes cannot cross event slugs or hosts',()=>{
  const {observation}=fixture('methstreams');
  for(const suffix of ['main/1','main/2','hotel/1']){
    const server=`https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/${suffix}`;
    assert.equal(validEventPagePair(observation.url,server),true);
    for(const changed of [server.replace('detroit-lions','other-team'),server.replace('fxtrend.st','fxtrend.st.evil.test'),
      server.replace('https:','http:'),`${server}?paid=1`])
      assert.equal(validEventPagePair(observation.url,changed),false);
  }
});
