import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {load} from 'cheerio';
import test from 'node:test';
import {createFixtureCollector} from '../lib/football/adapters/sources.ts';

const require=createRequire(import.meta.url);
const {createSourcePageReader}=require('../desktop/source-page-reader.cjs');
const category='https://dudestream1.com/category/nhl/';
const html='<h1>Category: NHL</h1><article class="hentry"><h4 class="entry-title">Florida Panthers vs Buffalo Sabres</h4></article>';

function harness(page=html,render=false) {
  const windows:FakeWindow[]=[];
  const snapshots:unknown[]=[];
  let completed:(details:{resourceType:string;webContentsId?:number;statusCode:number})=>void=()=>{};
  let challenge=false;
  let beforeRequest:((details:unknown,callback:(value:unknown)=>void)=>void)|undefined;
  let networkBudget:(()=>{received:(bytes:number)=>boolean}|undefined)|undefined;
  const sourceSession=Object.assign(new EventEmitter(),{
    setPermissionRequestHandler(){},setPermissionCheckHandler(){},clearStorageData:async()=>{},clearCache:async()=>{},
    webRequest:{onCompleted(_filter:unknown,callback:typeof completed){completed=callback;},onBeforeRequest(callback:typeof beforeRequest){beforeRequest=callback;}},
  });
  class FakeWindow extends EventEmitter {
    destroyed=false;
    url='';policy='';
    popup:()=>{action:string}=()=>({action:'allow'});
    webContents=Object.assign(new EventEmitter(),{
      id:windows.length+1,
      setAudioMuted(){},setWebRTCIPHandlingPolicy:(value:string)=>{this.policy=value;},setWindowOpenHandler:(handler:typeof this.popup)=>{this.popup=handler;},
      getURL:()=>this.url,
      executeJavaScript:async(script:string)=>{
        if(!render)return {ready:!challenge,url:this.url,challenge,body:challenge?null:page};
        const $=load(page);
        const snapshot=runInNewContext(script,{TextEncoder,location:{href:this.url},document:{title:$('title').text(),body:{innerText:$('body').text()},
          documentElement:{outerHTML:page},querySelector(selector:string){const node=$(selector).first();return node.length?{textContent:node.text()}:null;}}});
        snapshots.push(snapshot);
        return snapshot;
      },
    });
    constructor(options:{webPreferences:{disableDialogs:boolean}}){super();assert.equal(options.webPreferences.disableDialogs,true);windows.push(this);}
    async loadURL(url:string){
      assert.equal(this.policy,'disable_non_proxied_udp');
      this.url=url;
      completed({resourceType:'mainFrame',webContentsId:this.webContents.id,statusCode:challenge?403:200});
      this.webContents.emit('did-navigate',{},url,challenge?403:200);
    }
    isDestroyed(){return this.destroyed;}
    destroy(){this.destroyed=true;this.emit('closed');}
  }
  return {reader:createSourcePageReader({BrowserWindow:FakeWindow,session:{fromPartition:()=>sourceSession},
    createProxy:(options:{getBudget:typeof networkBudget})=>{
      networkBudget=options.getBudget;
      return {start:async()=>{},stop(){},credentials:{username:'fixture',password:'fixture'}};
    }}),windows,snapshots,receiveBytes:(bytes:number)=>networkBudget?.()?.received(bytes),
    navigateAfterChallenge(url=category){
      challenge=false;
      const window=windows[0];
      completed({resourceType:'mainFrame',statusCode:200});
      window.webContents.emit('did-navigate',{},url,200);
      window.webContents.emit('did-finish-load');
    },
    request(details:unknown){let decision:unknown=null;beforeRequest?.(details,value=>{decision=value;});return decision;},
    challenge(){challenge=true;}};
}

test('a source browser returns trusted category HTML and releases its sandboxed window',async()=>{
  const fake=harness();
  const result=await fake.reader.read(category,new AbortController().signal);
  assert.deepEqual(result,{kind:'complete',url:category,body:html});
  assert.equal(fake.windows.length,1);
  assert.equal(fake.windows[0].destroyed,true);
  assert.deepEqual(fake.windows[0].popup(),{action:'deny'});
  fake.reader.stop();
});

test('a source browser recognizes the captured numbered WordPress article template',async()=>{
  const body=readFileSync(new URL('./fixtures/dudestream-event-reader.html',import.meta.url),'utf8');
  const fake=harness(body,true);
  const controller=new AbortController();
  const reading=fake.reader.read('https://dudestream1.com/nba1/',controller.signal);
  await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  let complete=false;
  void reading.then(()=>{complete=true;},()=>{});
  await Promise.resolve();
  if(!complete){controller.abort();await reading.catch(()=>{});fake.reader.stop();assert.fail('Captured article must be ready without waiting for a deadline');}
  assert.deepEqual(await reading,{kind:'complete',url:'https://dudestream1.com/nba1/',body});
  fake.reader.stop();
});

test('source browser rejects unrelated URLs before opening a window',async()=>{
  const fake=harness();
  assert.deepEqual(await fake.reader.read('https://dudestream1.com/category/nhl/?redirect=1',new AbortController().signal),
    {kind:'failed',reason:'unsupported-address'});
  assert.equal(fake.windows.length,0);
  fake.reader.stop();
});

test('a source browser bounds its queue, removes aborted waiters and closes pending work',async()=>{
  const fake=harness();fake.challenge();
  const active=fake.reader.read(category,new AbortController().signal);
  const controller=new AbortController();
  const waiting=fake.reader.read('https://dudestream1.com/category/nba/',controller.signal);
  const pending=Array.from({length:11},()=>fake.reader.read(category,new AbortController().signal));
  assert.deepEqual(await fake.reader.read(category,new AbortController().signal),{kind:'failed',reason:'capacity'});
  controller.abort();
  await assert.rejects(waiting,{name:'AbortError'});
  fake.reader.stop();
  assert.deepEqual(await active,{kind:'failed',reason:'closed'});
  assert.equal(fake.windows.length,1);
  assert.equal(fake.windows[0].destroyed,true);
  assert.deepEqual(await Promise.all(pending),Array.from({length:11},()=>({kind:'failed',reason:'closed'})));
});

test('source browser deadlines include a page which remains challenged',async context=>{
  context.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
  const fake=harness();fake.challenge();
  const pending=fake.reader.read(category,new AbortController().signal);
  await Promise.resolve();await Promise.resolve();
  context.mock.timers.tick(35_000);
  assert.deepEqual(await pending,{kind:'failed',reason:'challenge'});
  assert.equal(fake.windows[0].destroyed,true);
  fake.reader.stop();
});

test('a committed source navigation clears403 when the completed callback omits its window ID',async context=>{
  context.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
  const fake=harness();fake.challenge();
  const pending=fake.reader.read(category,new AbortController().signal);
  await Promise.resolve();await Promise.resolve();
  fake.navigateAfterChallenge();
  for(let turn=0;turn<8;turn++)await Promise.resolve();
  context.mock.timers.tick(35_000);
  assert.deepEqual(await pending,{kind:'complete',url:category,body:html});
  assert.equal(fake.windows[0].destroyed,true);
  fake.reader.stop();
});

test('a committed200 for a different source path does not clear the requested403',async context=>{
  context.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
  const fake=harness();fake.challenge();
  const pending=fake.reader.read(category,new AbortController().signal);
  await Promise.resolve();await Promise.resolve();
  fake.navigateAfterChallenge('https://dudestream1.com/category/nba/');
  for(let turn=0;turn<8;turn++)await Promise.resolve();
  context.mock.timers.tick(35_000);
  assert.deepEqual(await pending,{kind:'failed',reason:'challenge'});
  fake.reader.stop();
});

test('a source browser measures its HTML byte limit and closes oversized pages',async()=>{
  const fake=harness('€'.repeat(2*1024*1024));
  assert.deepEqual(await fake.reader.read(category,new AbortController().signal),{kind:'failed',reason:'response-too-large'});
  assert.equal(fake.windows[0].destroyed,true);
  fake.reader.stop();
});

test('an oversized source DOM never crosses the renderer IPC boundary as HTML',async()=>{
  const fake=harness(`${html}${'x'.repeat(4*1024*1024)}`,true);
  assert.deepEqual(await fake.reader.read(category,new AbortController().signal),{kind:'failed',reason:'response-too-large'});
  assert.deepEqual(fake.snapshots.map(snapshot=>snapshot&&typeof snapshot==='object'&&'body' in snapshot?snapshot.body:undefined),[null]);
  assert.equal(fake.windows[0].destroyed,true);
  fake.reader.stop();
});

test('native 403 remains the original failure when no source browser is configured',async()=>{
  const detail='https://dudestream1.com/nba3/';
  const priorOrigin=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  try {
    const collector=createFixtureCollector();
    collector.enqueueFixture({url:detail,status:403,body:'challenge'});
    await assert.rejects(collector.readHtml(detail,new AbortController().signal),/http-403/);
  } finally {
    if(priorOrigin!==undefined)process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=priorOrigin;
  }
});

test('native 403 alone uses the configured source browser while native success stays native',async()=>{
  const detail='https://dudestream1.com/nba3/';
  const requests:string[]=[];
  let malformed=false;
  const server=createServer(async(request,response)=>{
    requests.push(request.url??'');
    assert.equal(request.headers['x-sunday-control-token'],'source-reader-test-token');
    let input='';for await(const chunk of request)input+=chunk;
    assert.equal(JSON.parse(input).url,detail);
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify(malformed?{kind:'complete',body:7}:{kind:'complete',url:detail,body:html}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const priorOrigin=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN,priorToken=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='source-reader-test-token';
  try {
    const collector=createFixtureCollector();
    collector.enqueueFixture({url:detail,status:403,body:'challenge'});
    assert.equal(await collector.readHtml(detail,new AbortController().signal),html);
    collector.enqueueFixture({url:detail,body:'native page'});
    assert.equal(await collector.readHtml(detail,new AbortController().signal),'native page');
    collector.enqueueFixture({url:detail,status:503,body:'temporary failure'});
    await assert.rejects(collector.readHtml(detail,new AbortController().signal),/http-503/);
    malformed=true;
    collector.enqueueFixture({url:detail,status:403,body:'challenge'});
    await assert.rejects(collector.readHtml(detail,new AbortController().signal),/source-page-invalid-response/);
    assert.deepEqual(requests,['/source-page','/source-page']);
  } finally {
    if(priorOrigin===undefined)delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=priorOrigin;
    if(priorToken===undefined)delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;else process.env.SUNDAY_ROOM_CONTROL_TOKEN=priorToken;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});


test('source acquisition blocks maintained-list ad scripts while retaining player-page scripts',async()=>{
  const fake=harness();fake.challenge();
  const pending=fake.reader.read(category,new AbortController().signal);
  try{
    assert.deepEqual(fake.request({url:'https://googleads.g.doubleclick.net/pagead/ads',resourceType:'script',referrer:category}),{cancel:true});
    assert.deepEqual(fake.request({url:'https://dudestream1.com/wp-includes/js/jquery/jquery.min.js',resourceType:'script',referrer:category}),{cancel:false});
    assert.deepEqual(fake.request({url:'https://127.0.0.1/private',resourceType:'script',referrer:category}),{cancel:true});
  }finally{fake.reader.stop();await pending;}
});

test('source acquisition closes its window when network traffic exceeds the capture budget',async()=>{
  const fake=harness();fake.challenge();
  const pending=fake.reader.read(category,new AbortController().signal);
  try{
    assert.equal(fake.receiveBytes(24*1024*1024+1),false);
    assert.deepEqual(await pending,{kind:'failed',reason:'byte-budget'});
    assert.equal(fake.windows[0].destroyed,true);
  }finally{fake.reader.stop();}
});

test('source acquisition caps subresource requests before its DOM deadline',async()=>{
  const fake=harness();fake.challenge();
  const pending=fake.reader.read(category,new AbortController().signal);
  const request={url:'https://dudestream1.com/assets/catalog.js',resourceType:'script',referrer:category};
  try{
    for(let index=0;index<200;index++)assert.deepEqual(fake.request(request),{cancel:false});
    assert.deepEqual(fake.request(request),{cancel:true});
    assert.deepEqual(await pending,{kind:'failed',reason:'request-budget'});
    assert.equal(fake.windows[0].destroyed,true);
  }finally{fake.reader.stop();}
});
