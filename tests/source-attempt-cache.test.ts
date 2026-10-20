import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {performance} from 'node:perf_hooks';
import {FootballStore} from '../lib/football/adapters/store.ts';
import type {SourceAttempt} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T18:00:00Z');
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'source-attempt-cache-')),path=join(directory,'state.sqlite');
 const store=new FootballStore(path),other=new DatabaseSync(path);
 return {store,other,close(){other.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}
function catalog(time:number){
 return {receivedAt:time,catalog:{runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:time,
  state:{kind:'complete' as const,at:time},categories:{nfl:{kind:'collected' as const,at:time},ncaaf:{kind:'pending' as const}},
  events:[],rejectedGames:[]}};
}
const listing=(time:number,count=1):SourceAttempt=>({at:time,outcome:'parsed',count,failures:0,nextEligibleAt:time+1_800_000});

test('repeated latest-attempt reads preserve values with retained history',context=>{
 const {store,other,close}=fixture();
 try{
  const insert=other.prepare('INSERT INTO catalog_attempts VALUES (?,?,?,?,?)');
  other.exec('BEGIN');
  for(let index=0;index<2048;index++)insert.run(`source-${index%4}`,'nfl',at+index,'parsed',JSON.stringify(listing(at+index,index)));
  other.exec('COMMIT');
  const expected=Object.fromEntries([0,1,2,3].map(index=>[`source-${index}`,listing(at+2044+index,2044+index)]));
   const started=performance.now(),cpu=process.cpuUsage();
   const values=Array.from({length:20},()=>store.sourceAttempts());
   const wallMs=performance.now()-started,used=process.cpuUsage(cpu);
   for(const value of values)assert.deepEqual(value,expected);
   context.diagnostic(JSON.stringify({reads:20,retained:2048,wallMs,cpuMs:(used.user+used.system)/1000}));
 }finally{close();}
});

test('same-store listing replacements invalidate cached values even at an unchanged timestamp',()=>{
 const {store,close}=fixture();
 try{
  store.saveListingAttempt('listing',listing(at),[]);
  assert.deepEqual(store.sourceAttempts(),{listing:listing(at)});
  store.saveListingAttempt('listing',listing(at,7),[]);
  assert.deepEqual(store.sourceAttempts(),{listing:listing(at,7)});
  store.saveListingAttempt('second',{at:at+1,outcome:'failed',failure:'blocked',failures:1,nextEligibleAt:at+300_001},[]);
  assert.deepEqual(store.sourceAttempts(),{listing:listing(at,7),second:{at:at+1,outcome:'failed',failure:'blocked',failures:1,nextEligibleAt:at+300_001}});
 }finally{close();}
});

for(const source of ['sportsurge-v2','streameast'] as const)test(`${source} catalog commits replace the latest attempt and sweeps expose older listing fallback`,()=>{
 const {store,close}=fixture();
 const old=at-31*86_400_000;
 try{
  store.saveListingAttempt(source,listing(old-1),[]);
  assert.deepEqual(store.sourceAttempts(),{[source]:listing(old-1)});
  if(source==='sportsurge-v2')store.saveSportsurgeCatalog({...catalog(old),catalog:{...catalog(old).catalog,catalogIssues:[]}},[]);
  else store.saveStreameastCatalog(catalog(old),[]);
  assert.deepEqual(store.sourceAttempts(),{[source]:{at:old,outcome:'empty',count:0,failures:0,nextEligibleAt:old+18_000_000}});
  store.sweep(at);
  assert.deepEqual(store.sourceAttempts(),{[source]:listing(old-1)});
 }finally{close();}
});

test('another connection commits listing and catalog corrections without stale latest values',()=>{
 const {store,other,close}=fixture();
 try{
  store.saveListingAttempt('listing',listing(at),[]);
  assert.deepEqual(store.sourceAttempts(),{listing:listing(at)});
  other.prepare('UPDATE sources SET payload=? WHERE id=?').run(JSON.stringify(listing(at,9)),'listing');
  assert.deepEqual(store.sourceAttempts(),{listing:listing(at,9)});
  other.prepare('INSERT INTO catalog_attempts VALUES (?,?,?,?,?)').run('listing','nfl',at+1,'empty',JSON.stringify({at:at+1,outcome:'empty',nextEligibleAt:at+50}));
  assert.deepEqual(store.sourceAttempts(),{listing:{at:at+1,outcome:'empty',nextEligibleAt:at+50}});
  other.prepare('DELETE FROM catalog_attempts').run();
  assert.deepEqual(store.sourceAttempts(),{listing:listing(at,9)});
 }finally{close();}
});

test('external rollback leaves the committed latest-attempt snapshot reusable',()=>{
 const {store,other,close}=fixture();
 try{
  store.saveListingAttempt('listing',listing(at),[]);store.sourceAttempts();
  other.exec('BEGIN');
  other.prepare('UPDATE sources SET payload=? WHERE id=?').run(JSON.stringify(listing(at,9)),'listing');
   assert.deepEqual(store.sourceAttempts(),{listing:listing(at)});
   other.exec('ROLLBACK');
   assert.deepEqual(store.sourceAttempts(),{listing:listing(at)});
 }finally{close();}
});

test('a failed listing transaction cannot publish its rolled-back attempt',()=>{
 const {store,other,close}=fixture();
 try{
  store.saveListingAttempt('listing',listing(at),[]);store.sourceAttempts();
  assert.throws(()=>store.saveListingAttempt('listing',listing(at+1,9),[],[
   {sourceId:'listing',eventId:'event',url:'invalid-url',league:'nfl',teams:['Away','Home'],gameId:'game',observedAt:at},
  ]));
  assert.deepEqual(store.sourceAttempts(),{listing:listing(at)});
  assert.deepEqual(other.prepare('SELECT payload FROM sources WHERE id=?').get('listing')?.payload,JSON.stringify(listing(at)));
 }finally{close();}
});

test('returned records and attempts stay independent of the store snapshot and each other',()=>{
 const {store,close}=fixture();
 try{
  store.saveListingAttempt('listing',listing(at),[]);
  const first=store.sourceAttempts(),second=store.sourceAttempts();
  first.listing.count=999;first.injected=listing(at+1);delete first.listing;
  assert.deepEqual(second,{listing:listing(at)});
  second.listing.outcome='failed';
  assert.deepEqual(store.sourceAttempts(),{listing:listing(at)});
 }finally{close();}
});

test('unrelated same-store writes leave latest attempts reusable',()=>{
 const {store,close}=fixture();
 try{
  store.saveListingAttempt('listing',listing(at),[]);store.sourceAttempts();
  store.saveDetailEvidence({outcome:'unresolved',observationId:'event',generation:'fixture',at,reason:'no-published-player',failures:0,nextEligibleAt:at+1});
   assert.deepEqual(store.sourceAttempts(),{listing:listing(at)});
 }finally{close();}
});
