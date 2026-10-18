import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import {SOURCE_REGISTRY} from '../lib/football/source-registry.ts';
import type {SportsurgeCatalog} from '../lib/football/shared.ts';

const require=createRequire(import.meta.url);
const {runSportsurgeSweep}=require('../desktop/sportsurge-sweep.cjs');
const categories=SOURCE_REGISTRY.find(source=>source.id==='sportsurge-v2')?.browserCategories;
assert.ok(categories);
const at=Date.parse('2026-09-26T21:00:00Z');
const fixture=(name:string)=>readFileSync(new URL(`./fixtures/sportsurge/${name}.html`,import.meta.url),'utf8');
const collegeCategory='https://v2.sportsurge.net/watch-cfb-streams/';
const footballCategory='https://v2.sportsurge.net/watch-nfl-streams/';
const firstEvent='https://v2.sportsurge.net/watch-65345-cfb-delaware-blue-hens-virginia-cavaliers/';
const secondEvent='https://v2.sportsurge.net/watch-65363-cfb-incarnate-word-cardinals-texas-state-bobcats/';

test('a live category publishes one provider list before the next slow category and then continues category coverage',async()=>{
  let clock=at;
  let firstPublishedAt:number|undefined;
  const reads:string[]=[];
  const checkpoints:SportsurgeCatalog[]=[];
  const result:SportsurgeCatalog=await runSportsurgeSweep({
    read:async(url:string,role:string)=>{
      reads.push(url);
      if(role==='detail')return fixture('detail');
      if(url===collegeCategory)return fixture('cfb');
      if(url===footballCategory){clock+=35_000;throw new Error('timeout');}
      if(url==='https://v2.sportsurge.net/watch-basketball-streams/')return fixture('nba')
        .replaceAll(/data-timestamp="\d+"/g,`data-timestamp="${Math.floor((at+30*60_000)/1000)}"`);
      return fixture('nfl');
    },
    send:async(catalog:SportsurgeCatalog)=>{
      checkpoints.push(structuredClone(catalog));
      const first=catalog.events.find(event=>event.id==='ncaaf:65345');
      if(first?.detail.kind==='collected'){
        firstPublishedAt??=clock;
        assert.equal(first.detail.providers.length,17);
      }
    },
    signal:new AbortController().signal,now:()=>clock,
    runId:'11111111-1111-4111-8111-111111111111',
  });
  assert.equal(firstPublishedAt,at,'the first live provider list must precede the unrelated category timeout');
  assert.deepEqual(reads.slice(0,6),[collegeCategory,firstEvent,footballCategory,
    'https://v2.sportsurge.net/watch-basketball-streams/',
    'https://v2.sportsurge.net/watch-66211-basketball-boston-celtics-cleveland-cavaliers-11/',
    'https://v2.sportsurge.net/watch-hockey-streams/']);
  assert.deepEqual(reads.filter(url=>categories.some(category=>category.url===url)),[...new Set(categories.map(category=>category.url))]);
  assert.equal(result.events.length,48);
  assert.equal(result.events.every(event=>event.detail.kind==='collected'),true);
  assert.equal(result.categories.ncaaf.kind,'collected');
  if(result.categories.ncaaf.kind==='collected')assert.equal(result.categories.ncaaf.at,at);
  assert.deepEqual(result.categories.nfl,{kind:'failed',at:at+35_000,reason:'timeout'});
  assert.equal(result.state.kind,'partial');
  assert.equal(checkpoints[1].events[0].detail.kind,'pending');
  assert.deepEqual(checkpoints.map(checkpoint=>checkpoint.sequence),Array.from({length:checkpoints.length},(_,index)=>index));
});

test('acknowledging the first live event skips its detail and advances the next live event before categories resume',async()=>{
  const reads:string[]=[];
  const result:SportsurgeCatalog=await runSportsurgeSweep({
    read:async(url:string,role:string)=>{
      reads.push(url);
      return role==='detail'?fixture('detail'):url===collegeCategory?fixture('cfb'):fixture('nfl');
    },
    send:async()=>({kind:'catalog-ack',skipDetailEventIds:['ncaaf:65345']}),
    signal:new AbortController().signal,now:()=>at,
    runId:'33333333-3333-4333-8333-333333333333',
  });
  assert.deepEqual(reads.slice(0,3),[collegeCategory,secondEvent,footballCategory]);
  assert.equal(reads.includes(firstEvent),false);
  assert.equal(result.events.length,46);
  assert.equal(result.events.every(event=>event.detail.kind==='collected'),true);
  assert.equal(result.state.kind,'complete');
});

test('one failed early detail resumes category coverage before another event from that category',async()=>{
  const reads:string[]=[];
  const result:SportsurgeCatalog=await runSportsurgeSweep({
    read:async(url:string,role:string)=>{
      reads.push(url);
      if(url===firstEvent)throw new Error('timeout');
      return role==='detail'?fixture('detail'):url===collegeCategory?fixture('cfb'):fixture('nfl');
    },
    send:async()=>{},signal:new AbortController().signal,now:()=>at,
    runId:'44444444-4444-4444-8444-444444444444',
  });
  assert.deepEqual(reads.slice(0,3),[collegeCategory,firstEvent,footballCategory]);
  assert.equal(reads.filter(url=>url===firstEvent).length,1);
  assert.deepEqual(result.events[0].detail,{kind:'failed',at,reason:'timeout'});
  assert.equal(result.events.filter(event=>event.detail.kind==='collected').length,46);
  assert.equal(result.state.kind,'partial');
});

for(const nearKickoff of [false,true])test(nearKickoff?
  'a game starting in one hour receives one early detail before the next category':
  'unknown and distant games wait until category coverage finishes',async()=>{
  const reads:{url:string;role:string}[]=[];
  const kickoff=at+(nearKickoff?60:120)*60_000;
  let college=fixture('cfb').replaceAll('class="live-badge"','class="inactive-badge"')
    .replaceAll(/data-timestamp="\d+"/g,`data-timestamp="${Math.floor((at+120*60_000)/1000)}"`);
  if(nearKickoff)college=college.replace('<span class="inactive-badge">LIVE</span>',`<time class="match-time" data-timestamp="${Math.floor(kickoff/1000)}"></time>`);
  const result:SportsurgeCatalog=await runSportsurgeSweep({
    read:async(url:string,role:string)=>{
      reads.push({url,role});
      return role==='detail'?fixture('detail'):url===collegeCategory?college:fixture('nfl');
    },
    send:async()=>{},signal:new AbortController().signal,now:()=>at,
    runId:'55555555-5555-4555-8555-555555555555',
  });
  if(nearKickoff)assert.deepEqual(reads.slice(0,3).map(read=>read.url),[collegeCategory,firstEvent,footballCategory]);
  else assert.deepEqual(reads.slice(0,9).map(read=>read.role),Array.from({length:9},()=>'category'));
  assert.equal(result.events.length,47);
  assert.equal(result.events.every(event=>event.detail.kind==='collected'),true);
  assert.equal(result.state.kind,'complete');
});

test('fresh category reuse retains its collection timestamps while a due category is collected',async()=>{
  const previousAt=at-60_000;
  const reads:string[]=[];
  const result:SportsurgeCatalog=await runSportsurgeSweep({
    read:async(url:string)=>{reads.push(url);return fixture('nfl');},
    send:async(catalog:SportsurgeCatalog)=>({kind:'catalog-ack',skipDetailEventIds:[],
      ...(catalog.sequence===0?{reuseCategories:{kind:'sportsurge-v2',
        categories:categories.filter(category=>category.league!=='nfl').map(category=>({league:category.league,at:previousAt})),events:[]}}:{})}),
    signal:new AbortController().signal,now:()=>at,
    runId:'22222222-2222-4222-8222-222222222222',
  });
  assert.deepEqual(reads,['https://v2.sportsurge.net/watch-nfl-streams/']);
  assert.deepEqual(result.categories.ncaaf,{kind:'collected',at:previousAt});
  assert.deepEqual(result.categories.nfl,{kind:'collected',at});
  assert.equal(result.state.kind,'complete');
});
