import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Worker} from 'node:worker_threads';
import {createFixtureCollector,SourceFetchError,SOURCES} from '../lib/football/adapters/sources.ts';

const sourceUrl=SOURCES.find(source=>source.id==='nflstreams')?.url;
assert.ok(sourceUrl);

async function waitForRequest(collector:ReturnType<typeof createFixtureCollector>,url:string) {
  for(let attempt=0;attempt<200;attempt++){
    if(collector.fixtureRequests().some(request=>request.url===url))return;
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  assert.fail(`Native request did not start: ${url}`);
}

test('native fixture reader follows same-host redirects and enforces the complete body limit',async()=>{
  const collector=createFixtureCollector();
  const start='https://ms.buffstream.io/cfb-streams-live-26';
  const target='https://ms.buffstream.io/cfb-streams/montana-state-live-stream';
  collector.enqueueFixture({url:start,status:302,headers:{location:'/cfb-streams/montana-state-live-stream'}});
  collector.enqueueFixture({url:target,chunks:[{body:'captured-'},{body:'page'}]});
  assert.equal(await collector.readHtml(start,new AbortController().signal),'captured-page');
  assert.deepEqual(collector.fixtureRequests().map(request=>request.url),[start,target]);

  collector.enqueueFixture({url:sourceUrl,body:'x'.repeat(2*1024*1024+1)});
  await assert.rejects(collector.readHtml(sourceUrl,new AbortController().signal),error=>
    error instanceof SourceFetchError&&error.message==='response-too-large');
  collector.enqueueFixture({url:sourceUrl,body:'healthy-after-cap'});
  assert.equal(await collector.readHtml(sourceUrl,new AbortController().signal),'healthy-after-cap');
});

test('native fixture reader cancels a response body and recovers on the next request',async()=>{
  const collector=createFixtureCollector();
  const controller=new AbortController();
  collector.enqueueFixture({url:sourceUrl,chunks:[{body:'prefix-'},{body:'tail',delayMs:30_000}]});
  const read=collector.readHtml(sourceUrl,controller.signal);
  await waitForRequest(collector,sourceUrl);
  await new Promise(resolve=>setTimeout(resolve,20));
  controller.abort(new DOMException('Canceled','AbortError'));
  await assert.rejects(read,error=>error instanceof DOMException&&error.name==='AbortError');
  assert.ok(collector.fixtureCancels().includes(sourceUrl));
  collector.enqueueFixture({url:sourceUrl,body:'fresh'});
  assert.equal(await collector.readHtml(sourceUrl,new AbortController().signal),'fresh');
});

test('native fixture reader preserves a timed-out read without poisoning later reads',async()=>{
  const collector=createFixtureCollector();
  collector.enqueueFixture({url:sourceUrl,failure:{message:'timed out'}});
  await assert.rejects(collector.readHtml(sourceUrl,new AbortController().signal),error=>
    error instanceof DOMException&&error.name==='TimeoutError');
  collector.enqueueFixture({url:sourceUrl,body:'recovered'});
  assert.equal(await collector.readHtml(sourceUrl,new AbortController().signal),'recovered');
});

test('a native stream failure cancels and settles three pending sibling reads',async()=>{
  const collector=createFixtureCollector();
  const source=SOURCES.find(item=>item.id==='streamed');
  assert.ok(source);
  const catalog=readFileSync(new URL('./fixtures/broad-sources/streamed.json',import.meta.url),'utf8');
  const row=collector.parseListings(source,catalog,Date.parse('2026-10-08T21:10:00Z')).observations
    .find(item=>item.title==='Buffalo Sabres vs Dallas Stars');
  assert.ok(row);
  const event=JSON.parse(catalog).find((item:{id:string})=>row.url.endsWith(item.id));
  event.sources=[1,2,3,4].map(id=>({source:'golf',id:String(id)}));
  const urls=event.sources.map((item:{id:string})=>`https://streamed.st/api/stream/golf/${item.id}`);
  collector.enqueueFixture({url:urls[0],failure:{message:'stream read failed'},delayMs:10});
  for(const url of urls.slice(1))collector.enqueueFixture({url,pending:true});
  await assert.rejects(collector.resolvePlayers('401892458',row,JSON.stringify(event),new AbortController().signal),
    /stream read failed/);
  assert.deepEqual(collector.fixtureRequests().map(request=>request.url).sort(),urls);
  for(const url of urls.slice(1))assert.ok(collector.fixtureCancels().includes(url),`unsettled sibling: ${url}`);
});

async function workerRead(index:number):Promise<string> {
  const worker=new Worker(new URL('./native-collector-worker.mjs',import.meta.url),
    {workerData:index,execArgv:['--experimental-strip-types']});
  try {
    return await new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`Native collector worker ${index} did not finish`)),10_000);
      worker.once('message',value=>{clearTimeout(timer);resolve(String(value));});
      worker.once('error',error=>{clearTimeout(timer);reject(error);});
      worker.once('exit',code=>{if(code!==0){clearTimeout(timer);reject(new Error(`Native collector worker exited ${code}`));}});
    });
  } finally { await worker.terminate(); }
}

test('native collector survives ten worker unloads between main-thread fixture reads',async()=>{
  const collector=createFixtureCollector();
  collector.enqueueFixture({url:sourceUrl,body:'main-before'});
  assert.equal(await collector.readHtml(sourceUrl,new AbortController().signal),'main-before');
  for(let index=0;index<10;index++)assert.equal(await workerRead(index),`worker-${index}`);
  collector.enqueueFixture({url:sourceUrl,body:'main-after'});
  assert.equal(await collector.readHtml(sourceUrl,new AbortController().signal),'main-after');
});
