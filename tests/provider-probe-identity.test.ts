import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import {openProvider,providerProbeIdentity} from '../lib/playback/provider-registry.ts';
import type {CandidateLocator} from '../lib/football/shared.ts';

const locator=():Extract<CandidateLocator,{provider:'event-page'}>=>({provider:'event-page',gameId:'10001',
  eventUrl:'https://methstreams.st/event/m-detroit-lions-vs-carolina-panthers-1005',
  serverUrl:'https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/core/1'});
const shared='["event-page","fxtrend","10001","https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/core/1"]';

test('repeated public probe identity lookups preserve shared bytes without reparsing unchanged URLs',()=>{
  const original=globalThis.URL;
  let parses=0;
  class CountedURL extends original {
    constructor(input:string|URL,base?:string|URL){super(input,base);parses++;}
  }
  const instrument=mock.method(globalThis,'URL',CountedURL);
  try{
    const value=locator();
    assert.equal(providerProbeIdentity(value),shared);
    const first=parses;
    assert.ok(first>0);
    for(let index=0;index<100;index++)assert.equal(providerProbeIdentity(value),shared);
    assert.equal(parses,first,'unchanged identity lookups must not repeatedly parse event and server URLs');
    assert.equal(providerProbeIdentity({...value,eventUrl:value.eventUrl.replace('methstreams','crackstreams')}),shared);
  }finally{instrument.mock.restore();}
});

test('mutated event-page game, event and server fields produce fresh exact identities',()=>{
  const game=locator();assert.equal(providerProbeIdentity(game),shared);
  game.gameId='10002';
  assert.equal(providerProbeIdentity(game),'["event-page","fxtrend","10002","https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/core/1"]');
  const event=locator();assert.equal(providerProbeIdentity(event),shared);
  event.eventUrl='https://methstreams.st/event/unrelated';
  assert.equal(providerProbeIdentity(event),'{"provider":"event-page","gameId":"10001","eventUrl":"https://methstreams.st/event/unrelated","serverUrl":"https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/core/1"}');
  const server=locator();assert.equal(providerProbeIdentity(server),shared);
  server.serverUrl='https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/vector/2';
  assert.equal(providerProbeIdentity(server),'["event-page","fxtrend","10001","https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/vector/2"]');
});

test('invalid pairs preserve full fallback JSON including changed extra runtime fields',()=>{
  const value={...locator(),eventUrl:'https://invalid.example/event',extra:'one'};
  assert.equal(providerProbeIdentity(value),'{"provider":"event-page","gameId":"10001","eventUrl":"https://invalid.example/event","serverUrl":"https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/core/1","extra":"one"}');
  value.extra='two';
  assert.equal(providerProbeIdentity(value),'{"provider":"event-page","gameId":"10001","eventUrl":"https://invalid.example/event","serverUrl":"https://fxtrend.st/event/m-detroit-lions-vs-carolina-panthers-1005/core/1","extra":"two"}');
});

test('other providers retain JSON identity and opening still validates a previously identified event page',async()=>{
  const gooz:CandidateLocator={provider:'gooz',playerId:'100'};
  assert.equal(providerProbeIdentity(gooz),'{"provider":"gooz","playerId":"100"}');
  gooz.playerId='101';
  assert.equal(providerProbeIdentity(gooz),'{"provider":"gooz","playerId":"101"}');
  const value=locator();assert.equal(providerProbeIdentity(value),shared);
  value.serverUrl='https://unrelated.example/player';
  await assert.rejects(openProvider(value,new AbortController().signal,'playback'),/Unsupported event page/);
});
