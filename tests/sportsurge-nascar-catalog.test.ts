import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import {z} from 'zod';
import {matchObservation} from '../lib/football/domain/matching.ts';
import {sanitizeSportsurgeCatalog,sportsurgeObservation} from '../lib/football/domain/sportsurge-catalog.ts';
import {SportsurgeCatalogSchema,SportsurgeEventSchema} from '../lib/football/shared.ts';
import type {Game} from '../lib/football/shared.ts';

const {parseCategory,parseDetail,detailUrl}=createRequire(import.meta.url)('../desktop/sportsurge-catalog.cjs');
const at=Date.parse('2026-10-11T17:16:00Z');
const url='https://v2.sportsurge.net/watch-66547-nascar-nascar-cup-series-at-charlotte/';
const title='NASCAR Cup Series at Charlotte';
const html=`<main id="match-list-container"><a class="match-row" href="${url}" title="${title}">
  <span class="match-row-team-name">${title}</span> <span class="match-time" data-timestamp="1791745200">Today, 2:00 PM</span>
  <span class="match-row-mobile-category">Nascar</span> 3 Streams</a></main>`;
const game:Game={id:'nascar-cup-202610110021',league:'nascar-cup',name:title,date:'2026-10-11T19:00Z',
  race:{eventId:'202610110021',sessionId:'202610110021',session:'race',round:'Charlotte'},
  season:2026,partitions:['nascar-cup'],detail:'Scheduled',broadcast:'USA Net / HBO Max',status:'pre',lifecycle:'scheduled'};
const parsedCategory=z.object({kind:z.literal('collected'),events:z.array(SportsurgeEventSchema)});

test('the published Sportsurge NASCAR Cup race survives collection, catalog validation, and schedule matching',()=>{
  const category=parsedCategory.parse(parseCategory(html,'nascar-cup'));
  assert.equal(category.events.length,1);
  const event=category.events[0];
  assert.deepEqual(event,{id:'nascar-cup:66547',url,league:'nascar-cup',title,teams:null,sourceStatus:'upcoming',
    kickoff:1791745200000,advertisedLinkCount:3,detail:{kind:'pending'}});
  const providers=[['Tvsportslive','https://tvsportslive.fr/66547'],
    ['Iohit','https://iohit.st/event/charlotte-motor-speedway-the-chase-race-bank-of-america-400-nascar-cup-series-1791745200'],
    ['Dudestream1','https://dudestream1.com/nascar/']];
  const detail=`<div class="stream-list">${providers.map(([label,href])=>
    `<div class="stream-item" data-href="${href}"><span class="stream-row-site-name">${label}</span></div>`).join('')}</div>`;
  event.detail=SportsurgeEventSchema.shape.detail.parse(parseDetail(detail,event,at));
  assert.equal(event.detail.kind,'collected');
  if(event.detail.kind==='collected')assert.deepEqual(event.detail.providers.map(provider=>provider.destination),
    providers.map(([,href])=>({kind:'link',url:href})));
  const catalog=SportsurgeCatalogSchema.parse({runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
    state:{kind:'complete',at},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'collected',at},'nascar-cup':{kind:'collected',at}},events:[event],rejectedGames:[],catalogIssues:[]});
  assert.deepEqual(sanitizeSportsurgeCatalog(catalog),catalog);
  assert.deepEqual(matchObservation(sportsurgeObservation(event,at),[game],at),{kind:'matched',gameId:game.id});
  assert.equal(matchObservation(sportsurgeObservation({...event,kickoff:1791831600000},at),[game],at).kind,'unmatched');
});

test('NASCAR Cup routes cannot admit another series, sport, or host',()=>{
  for(const league of ['nascar-truck','motogp','f1'])assert.equal(detailUrl(url,league),null,league);
  for(const invalid of [url.replace('nascar-cup-series','nascar-truck-series'),url.replace('-nascar-','-motogp-'),
    url.replace('v2.sportsurge.net','v2.sportsurge.net.evil.test'),`${url}?other=1`,`${url}#player`]){
    assert.equal(detailUrl(invalid,'nascar-cup'),null,invalid);
  }
  const event={id:'nascar-cup:66547',url:url.replace('nascar-cup-series','nascar-truck-series'),league:'nascar-cup',
    title,teams:null,sourceStatus:'upcoming',kickoff:1791745200000,advertisedLinkCount:3,detail:{kind:'pending'}};
  const catalog=SportsurgeCatalogSchema.parse({runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
    state:{kind:'collecting'},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'collected',at},'nascar-cup':{kind:'collected',at}},events:[event],rejectedGames:[],catalogIssues:[]});
  assert.equal(sanitizeSportsurgeCatalog(catalog),null);
});

test('the shared NASCAR category does not turn a published Cup race into a Truck collection failure',()=>{
  assert.deepEqual(parseCategory(html,'nascar-truck'),{kind:'collected',events:[],rejectedGames:[],catalogIssues:[]});
});
