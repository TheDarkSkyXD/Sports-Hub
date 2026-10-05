import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import type {SportsurgeCatalog, StreameastCatalog} from '../lib/football/shared.ts';

const require=createRequire(import.meta.url);
const {runSportsurgeSweep}=require('../desktop/sportsurge-sweep.cjs');
const {runStreameastSweep}=require('../desktop/streameast-sweep.cjs');
const {parseCategory:parseSurgeCategory,parseDetail:parseSurgeDetail}=require('../desktop/sportsurge-catalog.cjs');
const now=Date.parse('2026-10-03T23:30:00Z');
const runId='11111111-1111-4111-8111-111111111111';
const games=[
  {id:'ncaaf:10001',league:'ncaaf',title:'Final One vs Home One'},
  {id:'ncaaf:10002',league:'ncaaf',title:'Live Two vs Home Two'},
  {id:'ncaaf:10003',league:'ncaaf',title:'Uncertain Three vs Home Three'},
  {id:'nfl:20001',league:'nfl',title:'Final Four vs Home Four'},
  {id:'nfl:20002',league:'nfl',title:'Live Five vs Home Five'},
] as const;
const skipped=new Set(['ncaaf:10001','nfl:20001']);

function surgeUrl(game:typeof games[number]) {
  return `https://v2.sportsurge.net/watch-${game.id.split(':')[1]}-${game.league==='ncaaf'?'cfb':'nfl'}-${game.title.toLowerCase().replaceAll(' ','-')}/`;
}
function surgeCategory(league:'ncaaf'|'nfl') {
  return `<main id="match-list-container">${games.filter(game=>game.league===league).map(game=>
    `<a class="match-row" href="${surgeUrl(game)}"><span class="match-row-team-name">${game.title.split(' vs ')[0]}</span><span class="match-row-team-name">${game.title.split(' vs ')[1]}</span><span class="live-badge">Live</span><span>25 Streams</span></a>`).join('')}</main>`;
}
function surgeDetail(game:typeof games[number],count=25) {
  return `<div class="stream-list">${Array.from({length:count},(_,index)=>
    `<div class="stream-item" data-href="https://public-${game.id.split(':')[1]}.example/watch/${index}"><span class="stream-row-site-name">Provider ${index}</span><button class="stream-vote" id="stream-${game.id.split(':')[1]}${index.toString().padStart(2,'0')}"></button></div>`).join('')}</div>`;
}

test('NCAA and NFL rows retain 24 identities when a 25th public destination appears',()=>{
  for(const league of ['ncaaf','nfl'] as const) {
    const game=games.find(item=>item.league===league);
    assert.ok(game);
    const event=parseSurgeCategory(surgeCategory(league),league).events[0];
    const before=parseSurgeDetail(surgeDetail(game,24),event,now);
    const after=parseSurgeDetail(surgeDetail(game,25),event,now+1);
    assert.equal(before.kind,'collected');
    assert.equal(after.kind,'collected');
    assert.equal(before.providers.length,24);
    assert.equal(after.providers.length,25);
    assert.deepEqual(after.providers.slice(0,24).map(provider=>provider.id),before.providers.map(provider=>provider.id));
    assert.equal(new Set(after.providers.map(provider=>provider.id)).size,25);
    assert.equal(after.providers.every(provider=>provider.destination.kind==='link'),true);
    assert.equal(after.providers[24].destination.url,`https://public-${game.id.split(':')[1]}.example/watch/24`);
  }
});
function eastUrl(game:typeof games[number]) {
  return `https://v2.streameast.ga/${game.league==='ncaaf'?'cfb':'nfl'}/${game.title.toLowerCase().replaceAll(' ','-')}-${Math.floor(now/1000)}/`;
}
function eastCategory(league:'ncaaf'|'nfl') {
  return games.filter(game=>game.league===league).map(game=>
    `<article class="m-card" data-match-id="${game.id.split(':')[1]}" data-team-names="${game.title.replace(' vs ','|')}" data-time="${Math.floor(now/1000)}"><a class="m-card__link" aria-label="${game.title}" href="${eastUrl(game)}"></a></article>`).join('');
}
function eastDetail(game:typeof games[number]) {
  return `<div class="stream-alt-list">${[1,2].map(index=>
    `<a class="stream-alt-item" href="${eastUrl(game)}${index}"><span class="stream-alt-name">Free ${index}</span><span class="stream-alt-free-badge">Free</span></a>`).join('')}</div>`;
}

test('Sportsurge acknowledgments skip only confirmed IDs and keep all 25 providers for NCAA and NFL',async()=>{
  const reads:string[]=[];
  const sent:SportsurgeCatalog[]=[];
  const result:SportsurgeCatalog=await runSportsurgeSweep({
    read:async(url:string,page:string,league:'ncaaf'|'nfl')=>{
      reads.push(url);
      if(page==='category')return surgeCategory(league);
      const game=games.find(item=>surgeUrl(item)===url);
      assert.ok(game);
      assert.equal(skipped.has(game.id),false);
      return surgeDetail(game);
    },
    send:async(catalog:SportsurgeCatalog)=>{
      sent.push(structuredClone(catalog));
      return {kind:'catalog-ack',skipDetailEventIds:catalog.sequence===1?['ncaaf:10001','ncaaf:99999']:
        catalog.sequence===2?['nfl:20001']:[]};
    },
    signal:new AbortController().signal,now:()=>now,runId,
  });
  assert.deepEqual(sent.map(catalog=>catalog.sequence),Array.from({length:10},(_,index)=>index));
  assert.deepEqual(sent[1].events.map(event=>event.id),games.slice(0,3).map(game=>game.id));
  assert.deepEqual(sent[2].events.map(event=>event.id),games.slice(1).map(game=>game.id));
  assert.deepEqual(result.events.map(event=>event.id),['ncaaf:10002','ncaaf:10003','nfl:20002']);
  assert.equal(result.state.kind,'complete');
  assert.equal(result.events.every(event=>event.detail.kind==='collected'&&event.detail.providers.length===25),true);
  assert.equal(result.events.every(event=>event.detail.kind==='collected'&&event.detail.providers[24].destination.url.endsWith('/24')),true);
  assert.equal(reads.filter(url=>games.some(game=>surgeUrl(game)===url)).length,3);
  assert.equal(new Set(result.events.flatMap(event=>event.detail.kind==='collected'?event.detail.providers.map(provider=>`${event.id}:${provider.id}`):[])).size,75);
});

test('StreamEast acknowledgments skip only confirmed IDs and retain every free server',async()=>{
  const reads:string[]=[];
  const sent:StreameastCatalog[]=[];
  const result:StreameastCatalog=await runStreameastSweep({
    read:async(url:string,page:string,league:'ncaaf'|'nfl')=>{
      reads.push(url);
      if(page==='category')return eastCategory(league);
      if(page==='server')return `<iframe src="https://streame.center/stream-east/ch${url.endsWith('1')?'33':'34'}.php"></iframe>`;
      const game=games.find(item=>eastUrl(item)===url);
      assert.ok(game);
      assert.equal(skipped.has(game.id),false);
      return eastDetail(game);
    },
    send:async(catalog:StreameastCatalog)=>{
      sent.push(structuredClone(catalog));
      return {kind:'catalog-ack',skipDetailEventIds:catalog.sequence===1?['ncaaf:10001','ncaaf:99999']:
        catalog.sequence===2?['nfl:20001']:[]};
    },
    signal:new AbortController().signal,now:()=>now,runId,
  });
  assert.deepEqual(sent.map(catalog=>catalog.sequence),Array.from({length:16},(_,index)=>index));
  assert.deepEqual(sent[1].events.map(event=>event.id),games.slice(0,3).map(game=>game.id));
  assert.deepEqual(sent[2].events.map(event=>event.id),games.slice(1).map(game=>game.id));
  assert.deepEqual(result.events.map(event=>event.id),['ncaaf:10002','ncaaf:10003','nfl:20002']);
  assert.equal(result.state.kind,'complete');
  assert.equal(result.events.every(event=>event.detail.kind==='collected'&&event.detail.servers.length===2),true);
  assert.equal(reads.filter(url=>url.endsWith('/1')||url.endsWith('/2')).length,6);
});

test('a limit fallback replays the exact accepted checkpoint before skipped events are removed',async()=>{
  const sent:SportsurgeCatalog[]=[];
  await assert.rejects(runSportsurgeSweep({
    read:async(_url:string,_page:string,league:'ncaaf'|'nfl')=>surgeCategory(league),
    send:async(catalog:SportsurgeCatalog)=>{
      sent.push(structuredClone(catalog));
      if(catalog.sequence===1)return {kind:'catalog-ack',skipDetailEventIds:['ncaaf:10001']};
      if(catalog.sequence===2&&catalog.state.kind==='collecting')throw new Error('limit');
    },
    signal:new AbortController().signal,now:()=>now,runId,
  }),/limit/);
  assert.equal(sent.at(-1)?.state.kind,'partial');
  assert.deepEqual(sent.at(-1)?.events.map(event=>event.id),games.slice(0,3).map(game=>game.id));
});

test('Sportsurge removes late acknowledged events from pending work without reordering retained games',async()=>{
  const reads:string[]=[];
  const sent:SportsurgeCatalog[]=[];
  const result:SportsurgeCatalog=await runSportsurgeSweep({
    read:async(url:string,page:string,league:'ncaaf'|'nfl')=>{
      if(page==='category')return surgeCategory(league);
      reads.push(url);
      const game=games.find(item=>surgeUrl(item)===url);
      assert.ok(game);
      return surgeDetail(game);
    },
    send:async(catalog:SportsurgeCatalog)=>{
      sent.push(structuredClone(catalog));
      return {kind:'catalog-ack',skipDetailEventIds:catalog.sequence===3?['ncaaf:10002','nfl:20001']:[]};
    },
    signal:new AbortController().signal,now:()=>now,runId,
  });
  assert.deepEqual(reads,[surgeUrl(games[0]),surgeUrl(games[2]),surgeUrl(games[4])]);
  assert.deepEqual(sent.map(catalog=>catalog.sequence),Array.from({length:10},(_,index)=>index));
  assert.deepEqual(sent[3].events.map(event=>event.id),games.map(game=>game.id));
  assert.deepEqual(sent[4].events.map(event=>event.id),['ncaaf:10001','ncaaf:10003','nfl:20002']);
  assert.deepEqual(result.events.map(event=>event.id),['ncaaf:10001','ncaaf:10003','nfl:20002']);
  assert.equal(result.state.kind,'complete');
  assert.equal(result.events.every(event=>event.detail.kind==='collected'&&event.detail.providers.length===25),true);
});

test('StreamEast removes late acknowledged events before reading their detail or free servers',async()=>{
  const reads:string[]=[];
  const sent:StreameastCatalog[]=[];
  const result:StreameastCatalog=await runStreameastSweep({
    read:async(url:string,page:string,league:'ncaaf'|'nfl')=>{
      if(page==='category')return eastCategory(league);
      reads.push(url);
      if(page==='server')return `<iframe src="https://streame.center/stream-east/ch${url.endsWith('1')?'33':'34'}.php"></iframe>`;
      const game=games.find(item=>eastUrl(item)===url);
      assert.ok(game);
      return eastDetail(game);
    },
    send:async(catalog:StreameastCatalog)=>{
      sent.push(structuredClone(catalog));
      return {kind:'catalog-ack',skipDetailEventIds:catalog.sequence===3?['ncaaf:10002','nfl:20001']:[]};
    },
    signal:new AbortController().signal,now:()=>now,runId,
  });
  assert.deepEqual(reads,[eastUrl(games[0]),`${eastUrl(games[0])}1`,`${eastUrl(games[0])}2`,
    eastUrl(games[2]),`${eastUrl(games[2])}1`,`${eastUrl(games[2])}2`,
    eastUrl(games[4]),`${eastUrl(games[4])}1`,`${eastUrl(games[4])}2`]);
  assert.deepEqual(sent.map(catalog=>catalog.sequence),Array.from({length:16},(_,index)=>index));
  assert.deepEqual(sent[3].events.map(event=>event.id),games.map(game=>game.id));
  assert.deepEqual(sent[4].events.map(event=>event.id),['ncaaf:10001','ncaaf:10003','nfl:20002']);
  assert.deepEqual(result.events.map(event=>event.id),['ncaaf:10001','ncaaf:10003','nfl:20002']);
  assert.equal(result.state.kind,'complete');
  assert.equal(result.events.every(event=>event.detail.kind==='collected'&&event.detail.servers.length===2),true);
});

test('a rate limit after an acknowledged category keeps only retained events in the partial checkpoint',async()=>{
  const sent:StreameastCatalog[]=[];
  const result:StreameastCatalog=await runStreameastSweep({
    read:async(_url:string,page:string,league:'ncaaf'|'nfl')=>{
      if(page==='category'&&league==='nfl')throw new Error('rate-limited');
      return eastCategory(league);
    },
    send:async(catalog:StreameastCatalog)=>{
      sent.push(structuredClone(catalog));
      return {kind:'catalog-ack',skipDetailEventIds:catalog.sequence===1?['ncaaf:10001']:[]};
    },
    signal:new AbortController().signal,now:()=>now,runId,
  });
  assert.deepEqual(sent.map(catalog=>catalog.sequence),[0,1,2]);
  assert.equal(result.state.kind,'partial');
  assert.deepEqual(result.events.map(event=>event.id),['ncaaf:10002','ncaaf:10003']);
  assert.equal(result.events.every(event=>event.detail.kind==='pending'),true);
});

test('both sweeps preserve the accepted payload when a limit follows a late acknowledgement',async()=>{
  for(const provider of ['sportsurge','streameast']) {
    const sent:(SportsurgeCatalog|StreameastCatalog)[]=[];
    const run=provider==='sportsurge'?runSportsurgeSweep:runStreameastSweep;
    const eventUrl=provider==='sportsurge'?surgeUrl:eastUrl;
    await assert.rejects(run({
      read:async(url:string,page:string,league:'ncaaf'|'nfl')=>{
        if(page==='category')return provider==='sportsurge'?surgeCategory(league):eastCategory(league);
        if(page==='server')return '<iframe src="https://streame.center/stream-east/ch33.php"></iframe>';
        const game=games.find(item=>eventUrl(item)===url);
        assert.ok(game);
        return provider==='sportsurge'?surgeDetail(game):eastDetail(game);
      },
      send:async(catalog:SportsurgeCatalog|StreameastCatalog)=>{
        sent.push(structuredClone(catalog));
        if(catalog.sequence===4&&catalog.state.kind==='collecting')throw new Error('limit');
        return {kind:'catalog-ack',skipDetailEventIds:catalog.sequence===3?['ncaaf:10002','nfl:20001']:[]};
      },
      signal:new AbortController().signal,now:()=>now,runId,
    }),/limit/);
    assert.deepEqual(sent.map(catalog=>catalog.sequence),[0,1,2,3,4,4],provider);
    assert.deepEqual(sent[4].events.map(event=>event.id),['ncaaf:10001','ncaaf:10003','nfl:20002'],provider);
    assert.deepEqual(sent[5],{...sent[3],sequence:4,state:{kind:'partial',at:now,reason:'limit'}},provider);
  }
});

for(const provider of ['sportsurge','streameast'] as const)
for(const [stage,skipAt] of [['before detail',2],['after detail',3]] as const)
test(`${provider} drops a newly excluded event ${stage} without publishing its detail`,async()=>{
  const run=provider==='sportsurge'?runSportsurgeSweep:runStreameastSweep;
  const eventUrl=provider==='sportsurge'?surgeUrl:eastUrl;
  const first=games[0];
  const reads:{url:string;page:string}[]=[];
  const result:SportsurgeCatalog|StreameastCatalog=await run({
    read:async(url:string,page:string,league:'ncaaf'|'nfl')=>{
      reads.push({url,page});
      if(page==='category')return provider==='sportsurge'?surgeCategory(league):eastCategory(league);
      if(page==='server')return '<iframe src="https://streame.center/stream-east/ch33.php"></iframe>';
      const game=games.find(item=>eventUrl(item)===url);
      assert.ok(game);
      return provider==='sportsurge'?surgeDetail(game):eastDetail(game);
    },
    send:async(catalog:SportsurgeCatalog|StreameastCatalog)=>({kind:'catalog-ack',
      skipDetailEventIds:catalog.sequence===skipAt?[first.id]:[]}),
    signal:new AbortController().signal,now:()=>now,runId,
  });
  assert.equal(result.state.kind,'complete');
  assert.equal(result.events.some(event=>event.id===first.id),false);
  assert.equal(reads.some(row=>row.page==='detail'&&row.url===eventUrl(first)),stage==='after detail');
  assert.equal(reads.some(row=>row.page==='server'&&row.url.startsWith(eventUrl(first))),false);
  assert.equal(result.events.every(event=>event.detail.kind==='collected'),true);
});

for(const [stage,skipAt,serverReads] of [['before first server',3,0],['after first server',4,1]] as const)
test(`StreamEast skips a changed event ${stage} without reading later servers`,async()=>{
  const first=games[0];
  const reads:{url:string;page:string}[]=[];
  const result:StreameastCatalog=await runStreameastSweep({
    read:async(url:string,page:string,league:'ncaaf'|'nfl')=>{
      reads.push({url,page});
      if(page==='category')return eastCategory(league);
      if(page==='server')return '<iframe src="https://streame.center/stream-east/ch33.php"></iframe>';
      const game=games.find(item=>eastUrl(item)===url);
      assert.ok(game);
      return eastDetail(game);
    },
    send:async(catalog:StreameastCatalog)=>({kind:'catalog-ack',
      skipDetailEventIds:catalog.sequence===skipAt?[first.id]:[]}),
    signal:new AbortController().signal,now:()=>now,runId,
  });
  assert.equal(result.state.kind,'complete');
  assert.equal(result.events.some(event=>event.id===first.id),false);
  assert.equal(reads.filter(row=>row.page==='server'&&row.url.startsWith(eastUrl(first))).length,serverReads);
  assert.equal(result.events.every(event=>event.detail.kind==='collected'),true);
});
