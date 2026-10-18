import assert from 'node:assert/strict';
import {test} from 'node:test';
import {allowedDiscoveryUrl,enrichObservation,parseListings} from '../lib/football/adapters/sources.ts';
import {SOURCE_REGISTRY} from '../lib/football/source-registry.ts';
import {sourceInventory} from '../lib/football/domain/source-inventory.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-11T17:40:00Z');
const title='Charlotte Motor Speedway The Chase Race Bank of America 400';
const slug='charlotte-motor-speedway-the-chase-race-bank-of-america-400';
const game:Game={id:'nascar-cup-202610110021',league:'nascar-cup',name:'NASCAR Cup Series at Charlotte',date:'2026-10-11T19:00Z',
  race:{eventId:'202610110021',sessionId:'202610110021',session:'race',round:'Charlotte'},season:2026,
  partitions:['nascar-cup'],detail:'Scheduled',status:'pre',lifecycle:'scheduled'};

test('new Buffstreams and Methstreams catalogs collect their published NASCAR race through the motorsports adapter',()=>{
  const html=`<section class="lg" id="g-lg-nascar-premier-20261011"><a class="ev ev-plain" href="/event/${slug}"
    title="${title}" data-start="1791745200"><span class="ev-t">${title}</span></a></section>`;
  for(const [id,host] of [['buffstreams-f1','buffstreams.ch'],['methstreams-vg-f1','methstreams.vg']]){
    const source=SOURCE_REGISTRY.find(source=>source.id===id);
    assert.ok(source,id);
    assert.equal(source.family,'motorsports');
    const parsed=parseListings(source,html,at);
    assert.equal(parsed.observations.length,1);
    assert.equal(parsed.observations[0].league,'nascar-cup');
    assert.equal(parsed.observations[0].url,`https://${host}/event/${slug}`);
    assert.equal(parsed.observations[0].kickoff,Date.parse(game.date));
  }
});

test('new motorsport discovery routes admit the published category and event without other site pages',()=>{
  for(const host of ['buffstreams.ch','methstreams.vg']){
    for(const url of [`https://${host}/F1`,`https://${host}/event/${slug}`])assert.equal(allowedDiscoveryUrl(url),true,url);
    for(const url of [`https://${host}/login`,`https://${host}/F1?other=1`,`https://${host}/event/${slug}#player`,
      `https://${host}/event/${slug}?other=1`,`https://${host}/event/${slug}/hotel/1`])assert.equal(allowedDiscoveryUrl(url),false,url);
  }
});

test('FoxTrend inventory retains its published Foxiy event under the requested category',()=>{
  const source=SOURCE_REGISTRY.find(source=>source.id==='foxtrend');
  assert.ok(source);
  const row:Observation={id:'foxtrend:inventory',sourceId:source.id,title,url:`https://foxiy.st/event/${slug}-nascar-cup-series-1791745200`,
    teams:null,league:'nascar-cup',kickoff:Date.parse(game.date),rawTime:'1791745200',observedAt:at,parserVersion:2};
  const inventory=sourceInventory({at,revision:1,lastDiscoveryAt:at,browserCollectorsAvailable:true,sources:[source],
    observations:[row],games:[game],candidates:new Map(),attempts:{},sportsurgeCatalog:{current:null,lastComplete:null,previous:null},
    streameastCatalog:{current:null,lastComplete:null,previous:null}}).sources[0];
  assert.equal(inventory.links.length,1);
  assert.equal(inventory.links[0].gameId,game.id);
  assert.deepEqual(inventory.scopes.find(scope=>scope.league==='nascar-cup')?.publicUrls,['https://foxtrend.app/Motor-Sports']);
});

test('new timed catalogs retain their verified event date when a detail page contains an unrelated time',()=>{
  for(const [sourceId,host] of [['buffstreams-f1','buffstreams.ch'],['methstreams-vg-f1','methstreams.vg']]){
    const row:Observation={id:`${sourceId}:date`,sourceId,title,url:`https://${host}/event/${slug}`,teams:null,
      league:'nascar-cup',kickoff:Date.parse(game.date),rawTime:'1791745200',observedAt:at,parserVersion:2};
    assert.deepEqual(enrichObservation(row,'<time datetime="2026-10-12T19:00:00Z"></time>'),row);
  }
});
