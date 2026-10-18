import assert from 'node:assert/strict';
import test from 'node:test';
import {compatiblePlayers,enrichObservation,missingPlayerReason,parseListings} from '../lib/football/adapters/sources.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-11T17:40:00Z');
const source={id:'foxtrend',url:'https://foxtrend.app/Motor-Sports',family:'motorsports'};
const title='Charlotte Motor Speedway — The Chase - Race: Bank of America 400';
const pathPart='charlotte-motor-speedway-the-chase-race-bank-of-america-400-nascar-cup-series-1791745200';
const url=`https://foxiy.st/event/${pathPart}`;
const row={t:title,tm:'Oct 11, 3:00 PM',pathPart,slug:'charlotte-motor-speedway-the-chase-race-bank-of-america-400',start:1791745200000,img:null,pop:1,cat:'motor-sports',sv:'epsilon'};
const game:Game={id:'nascar-cup-202610110021',league:'nascar-cup',name:'NASCAR Cup Series at Charlotte',date:'2026-10-11T19:00Z',
  race:{eventId:'202610110021',sessionId:'202610110021',session:'race',round:'Charlotte'},season:2026,partitions:['nascar-cup'],detail:'Scheduled',status:'pre',lifecycle:'scheduled'};
function catalog(rows:typeof row[],category='motor-sports',host='https://foxiy.st') {
  return `<script>window.FOXTREND_SCHEDULE_BOOT = {\n  watchBaseByCat: ${JSON.stringify({'motor-sports':host})},\n  events: ${JSON.stringify({byDate:{'2026-10-11':{[category]:rows}}})},\n};</script>`;
}
const observation:Observation={id:'foxtrend:fixture',sourceId:source.id,url,title,teams:null,league:'nascar-cup',kickoff:row.start,rawTime:String(row.start),observedAt:at,parserVersion:2};

test('FoxTrend collects the published NASCAR event from raw bootstrap data before and during the race',()=>{
  for(const tm of [row.tm,'Live']) {
    const result=parseListings(source,catalog([{...row,tm},{...row,tm}]),at);
    assert.equal(result.outcome,'parsed');
    assert.equal(result.observations.length,1);
    const event=result.observations[0];
    assert.deepEqual({url:event.url,title:event.title,kickoff:event.kickoff,league:event.league,teams:event.teams},
      {url,title,kickoff:row.start,league:'nascar-cup',teams:null});
    assert.deepEqual(matchObservation(event,[game],at),{kind:'matched',gameId:game.id});
    assert.equal(matchObservation({...event,kickoff:row.start+86400000},[game],at).kind,'unmatched');
  }
});

test('FoxTrend rejects mismatched dates, categories, hosts and unrelated series while retaining explicit Truck identity',()=>{
  for(const changed of [
    {...row,start:row.start+86400000},{...row,start:0},{...row,cat:'football'},
    {...row,pathPart:pathPart.replace('nascar-cup-series','motogp')},
    {...row,pathPart:pathPart+'?other=1'},{...row,pathPart:pathPart+'#other'},
    {...row,pathPart:'../'+pathPart},{...row,t:''},
  ])assert.equal(parseListings(source,catalog([changed]),at).observations.length,0,JSON.stringify(changed));
  assert.equal(parseListings(source,catalog([row],'football'),at).observations.length,0);
  assert.equal(parseListings(source,catalog([row],'motor-sports','https://foxiy.st.evil.example'),at).observations.length,0);
  const truck=parseListings(source,catalog([{...row,pathPart:pathPart.replace('nascar-cup-series','nascar-truck-series')}]),at).observations[0];
  assert.equal(truck?.league,'nascar-truck');
  assert.equal(matchObservation(truck,[game],at).kind,'unmatched');
  assert.equal(parseListings(source,'<script>window.FOXTREND_SCHEDULE_BOOT = { events: broken }</script>',at).outcome,'parser-changed');
});

test('FoxTrend cross-checks a rendered NASCAR card when one is present',()=>{
  const card=`<a class="card watch card-sport-motor-sports" href="${url}" aria-label="${title}"><h3 class="card-title">${title}</h3></a>`;
  assert.equal(parseListings(source,catalog([row])+card,at).observations.length,1);
  assert.equal(parseListings(source,catalog([row])+card.replaceAll(title,'Wrong race'),at).observations.length,0);
  assert.equal(parseListings(source,catalog([row])+card.replace(url,url+'1'),at).observations.length,0);
});

test('FoxTrend raw bootstrap keeps the title, slug and dated event route bound to one race',()=>{
  assert.equal(parseListings(source,catalog([row]),at).observations.length,1);
  for(const changed of [
    {...row,t:'NASCAR Cup Series at Talladega'},
    {...row,slug:'talladega-superspeedway'},
    {...row,pathPart:pathPart.replace('charlotte-motor-speedway','talladega-superspeedway')},
  ])assert.equal(parseListings(source,catalog([changed]),at).observations.length,0,JSON.stringify(changed));
});

test('FoxTrend preserves catalog identity and reports only the matching published countdown as pending',()=>{
  const gate=`<div class="ft-gate" id="ftGate" role="timer" data-open="1791741600" data-start="1791745200" data-kind="RACE DAY">Upcoming Streams open in</div>`;
  assert.deepEqual(compatiblePlayers(game.id,observation,gate+'<iframe src="https://gooz.aapmains.net/new-stream-embed/57069"></iframe>'),[]);
  assert.deepEqual(enrichObservation(observation,gate),observation);
  assert.equal(missingPlayerReason(observation,gate),'not-yet-published');
  assert.equal(missingPlayerReason(observation,gate.replace('1791745200','1791831600')),'no-compatible-media');
  assert.equal(missingPlayerReason(observation,'<div>Upcoming Streams open in</div>'),'no-compatible-media');
  assert.deepEqual(compatiblePlayers(game.id,observation,gate),[]);
});
