import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { parseListings } from '../lib/football/adapters/sources.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { SOURCE_REGISTRY } from '../lib/football/source-registry.ts';
import type { Game } from '../lib/football/shared.ts';

const wnbaAt = Date.parse('2026-10-18T14:00:00Z');
const wnbaListing = '<section class="lg" id="g-cat-nba-20261019"><a class="ev ev-plain" href="/event/m-atlanta-dream-vs-golden-state-valkyries-wnba-finals-game-2-1020" title="Atlanta Dream vs Golden State Valkyries (WNBA Finals Game 2)" data-start="1792454400"><span class="ev-t">Atlanta Dream vs Golden State Valkyries (WNBA Finals Game 2)</span><time datetime="2026-10-20T00:00:00Z">00:00 UTC</time></a></section>';
const team = (id:string,name:string):Game['home'] => ({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:null});
const wnbaGame:Game = {id:'wnba-401918306',league:'wnba',name:'Atlanta Dream at Golden State Valkyries',
  date:'2026-10-20T00:00Z',away:team('espn:wnba:20','Atlanta Dream'),home:team('espn:wnba:21','Golden State Valkyries'),
  status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,partitions:['wnba']};

for (const sourceId of ['methstreams-nba','crackstreams-nba','trend48','foxtrend-sports','mlbbite-nba']) {
  test(`${sourceId} refreshes a cached version 3 listing and publishes its corrected WNBA match`,async()=>{
    const source=SOURCE_REGISTRY.find(value=>value.id===sourceId);
    assert.ok(source);
    const directory=mkdtempSync(join(tmpdir(),`wnba-parser-refresh-${sourceId}-`));
    const path=join(directory,'state.sqlite');
    const store=new FootballStore(path);
    store.saveListingAttempt(source.id,{at:wnbaAt,outcome:'parsed',count:0,parserVersion:3,nextEligibleAt:wnbaAt+18_000_000},[]);
    store.close();
    let listingReads=0;
    const coordinator=createFootballCoordinator(path,{
      now:()=>wnbaAt,
      schedules:[{id:'wnba',league:'wnba',path:'/fixture',group:null}],
      sources:[source],
      readSchedule:async()=>({games:[wnbaGame],league:'wnba',at:wnbaAt}),
      readHtml:async url=>{
        if(url===source.url){listingReads++;return wnbaListing;}
        return '<main>No player published</main>';
      },
      parseListings,
    });
    try {
      await coordinator.refresh();
      for(let index=0;index<60;index++)await new Promise<void>(resolve=>setImmediate(resolve));
      const reply=await coordinator.command({kind:'sources'});
      assert.equal(reply.kind,'sources');
      if(reply.kind!=='sources')throw new Error('Expected sources snapshot');
      const game=reply.snapshot.games.find(value=>value.gameId===wnbaGame.id);
      assert.ok(game?.sourceLinks.some(link=>link.sourceId===source.id),`${source.id} must publish the corrected WNBA match`);
      assert.equal(listingReads,1,'the parser upgrade must bypass the saved retry deadline');
      await coordinator.refresh();
      assert.equal(listingReads,1,'the refreshed parser version must resume normal listing cadence');
    } finally {
      await coordinator.stop();
      rmSync(directory,{recursive:true,force:true});
    }
  });
}

for (const outcome of ['parsed', 'empty', 'unsupported', 'parser-changed', 'failed'] as const) {
  test(`a parser upgrade refreshes ${outcome} listings once and respects transport cooldowns`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'source-parser-refresh-'));
    const path = join(directory, 'state.sqlite');
    const at = Date.parse('2026-10-12T12:00:00Z');
    const store = new FootballStore(path);
    store.saveListingAttempt('fixture', {
      at, outcome, count: 0, parserVersion: 3, nextEligibleAt: at + 18_000_000,
      ...(outcome === 'failed' ? { failure: 'rate-limited' as const } : {}),
    }, []);
    store.close();
    let reads = 0;
    const coordinator = createFootballCoordinator(path, {
      now: () => at,
      sources: [{ id: 'fixture', url: 'https://fixture.example/list', family: 'fixture', parserVersion: 4 }],
      readSchedule: async source => ({ games: [], league: source.league, at }),
      readHtml: async () => { reads++; return '<main>empty</main>'; },
      parseListings: () => ({ outcome: 'empty', observations: [] }),
    });
    const refresh = async () => {
      await coordinator.refresh();
      for (let i = 0; i < 60; i++) await new Promise<void>(resolve => setImmediate(resolve));
    };
    try {
      await refresh();
      assert.equal(reads, outcome === 'failed' ? 0 : 1);
      await refresh();
      assert.equal(reads, outcome === 'failed' ? 0 : 1, 'the same parser version keeps the normal listing cadence');
    } finally {
      await coordinator.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
