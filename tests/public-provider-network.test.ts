import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {brotliCompressSync,deflateSync,gzipSync} from 'node:zlib';
import test,{type TestContext} from 'node:test';
import {createProbeResources,scopedFetch,timedFetch} from '../lib/playback/probe-capacity.ts';
import {publicHttpsRequest} from '../lib/playback/providers/public-page.ts';

function network(context:TestContext,{status=200,headers={},body=Buffer.from('game'),end=true}:
  {status?:number;headers?:Record<string,string>;body?:Buffer;end?:boolean}={}){
  let opened=0;
  const seen:Record<string,string>[]=[];
  const streams:PassThrough[]=[];
  context.mock.method(dns.promises,'lookup',async()=>[{address:'8.8.8.8',family:4}]);
  context.mock.method(https,'request',(...args:unknown[])=>{
    opened++;
    const options=args[1],callback=args[2];
    assert.ok(options&&typeof options==='object'&&'headers'in options&&options.headers&&typeof options.headers==='object'&&
      'lookup'in options&&typeof options.lookup==='function'&&typeof callback==='function');
    options.lookup('streame.center',{all:true},(error:unknown,addresses:unknown)=>{
      assert.equal(error,null);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);
    });
    seen.push(Object.fromEntries(Object.entries(options.headers).map(([name,value])=>[name,String(value)])));
    const stream=Object.assign(new PassThrough(),{headers,statusCode:status});streams.push(stream);
    const outgoing=Object.assign(new EventEmitter(),{
      end(){queueMicrotask(()=>{callback(stream);if(body.length)stream.write(body);if(end)stream.end();});},
      destroy(error?:Error){stream.destroy(error);this.emit('error',error);},
    });
    if('signal'in options&&options.signal instanceof AbortSignal){
      const signal=options.signal;
      signal.addEventListener('abort',()=>outgoing.destroy(signal.reason),{once:true});
    }
    return outgoing;
  });
  syncBuiltinESMExports();
  context.after(()=>{for(const stream of streams)stream.destroy();context.mock.restoreAll();syncBuiltinESMExports();});
  return {seen,streams,opened:()=>opened};
}

test('the default provider transport rejects private DNS before opening a socket',async context=>{
  let connections=0;
  const server=createServer(socket=>{connections++;socket.destroy();});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(8443,'127.0.0.1',resolve);});
  context.mock.method(dns,'lookup',(_host:unknown,options:unknown,callback:unknown)=>{
    assert.equal(typeof callback,'function');
    if(typeof callback==='function')callback(null,options&&typeof options==='object'&&'all'in options&&options.all?
      [{address:'127.0.0.1',family:4}]:'127.0.0.1',4);
  });
  context.mock.method(dns.promises,'lookup',async()=>[{address:'127.0.0.1',family:4}]);
  syncBuiltinESMExports();
  try{
    await assert.rejects(scopedFetch('https://streame.center:8443/player',{redirect:'manual',signal:AbortSignal.timeout(1000)}));
    assert.equal(connections,0,'a provider hostname must not connect to a private DNS answer');
  }finally{
    context.mock.restoreAll();syncBuiltinESMExports();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('all DNS answers are admitted before a public address is pinned',async context=>{
  const fixture=network(context);
  context.mock.method(dns.promises,'lookup',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);
  syncBuiltinESMExports();
  await assert.rejects(scopedFetch('https://streame.center/player',{redirect:'manual'}),/private address/);
  assert.equal(fixture.opened(),0);
});

test('a configured environment proxy cannot bypass the admitted DNS destination',async()=>{
  let connections=0;
  const server=createServer(socket=>{connections++;socket.destroy();});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert.ok(address&&typeof address==='object');
  try{
    const code=`import dns from 'node:dns';
      import {syncBuiltinESMExports} from 'node:module';
      dns.promises.lookup=async()=>[{address:'8.8.8.8',family:4}];syncBuiltinESMExports();
      const {scopedFetch}=await import('./lib/playback/probe-capacity.ts');
      try{const response=await scopedFetch('https://streame.center/player',{redirect:'manual',signal:AbortSignal.timeout(200)});await response.body?.cancel();}catch{}`;
    const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{
      cwd:process.cwd(),windowsHide:true,stdio:'pipe',env:{...process.env,NODE_USE_ENV_PROXY:'1',
        HTTPS_PROXY:`http://127.0.0.1:${address.port}`,https_proxy:`http://127.0.0.1:${address.port}`,NO_PROXY:'',no_proxy:''},
    });
    let errors='';child.stderr.on('data',chunk=>{errors+=String(chunk);});
    const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    assert.equal(exit,0,errors);assert.equal(connections,0,'environment proxies must not perform a second unvalidated DNS resolution');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

for(const [encoding,compress] of [['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]] as const)
  test('provider responses decode '+encoding+' and preserve range and source headers',async context=>{
    const compressed=compress(Buffer.from('{"game":"selected"}'));
    const fixture=network(context,{status:206,headers:{'content-type':'application/json','content-encoding':encoding,
      'content-length':String(compressed.length),'content-range':'bytes 0-18/19'},body:compressed});
    const input=new Request('https://streame.center/player',{redirect:'manual',headers:{Range:'bytes=0-',Referer:'https://streame.center/'}});
    const response=await scopedFetch(input);
    assert.equal(response.status,206);assert.equal(response.headers.get('content-encoding'),null);
    assert.equal(response.headers.get('content-length'),null);assert.equal(response.headers.get('content-range'),'bytes 0-18/19');
    assert.deepEqual(await response.json(),{game:'selected'});
    assert.equal(fixture.seen[0].range,'bytes=0-');assert.equal(fixture.seen[0].referer,'https://streame.center/');
  });

test('compressed provider data remains bounded after inflation',async context=>{
  const compressed=gzipSync(Buffer.alloc(65*1024*1024));
  network(context,{headers:{'content-encoding':'gzip','content-length':String(compressed.length)},body:compressed});
  const response=await scopedFetch('https://streame.center/player',{redirect:'manual'});
  await assert.rejects(response.arrayBuffer(),/byte budget/);
});

for(const status of [204,205,304])test('empty provider status '+status+' has no body',async context=>{
  network(context,{status,body:Buffer.alloc(0)});
  const response=await scopedFetch('https://streame.center/player',{redirect:'manual'});
  assert.equal(response.status,status);assert.equal(response.body,null);
});

test('provider redirects are returned for caller admission without following them',async context=>{
  const fixture=network(context,{status:302,headers:{location:'https://127.0.0.1/private'}});
  const response=await scopedFetch('https://streame.center/player',{redirect:'manual'});
  assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://127.0.0.1/private');
  await response.body?.cancel();assert.equal(fixture.opened(),1);
  await assert.rejects(scopedFetch('https://streame.center/player',{redirect:'follow'}),/manual GET/);
  await assert.rejects(scopedFetch('https://streame.center/player',{redirect:'manual',method:'POST',body:'data'}),/manual GET/);
  assert.equal(fixture.opened(),1);
});

test('one HTTP permit covers the pinned response until consumption or cancellation',async context=>{
  const fixture=network(context);
  const resources=createProbeResources({httpLimit:1,observerLimit:1,activeBudgetMs:1000});
  await resources.run(new AbortController().signal,()=>{},async signal=>{
    const response=await timedFetch(scopedFetch,'https://streame.center/player',{redirect:'manual',signal},500);
    assert.equal(await response.text(),'game');
    const next=await publicHttpsRequest(new URL('https://streame.center/player'),signal,new Headers());
    await next.body?.cancel();
  });
  assert.equal(fixture.opened(),2);assert.ok(fixture.streams.every(stream=>stream.destroyed));
});

test('abort during DNS opens no socket and abort during a body closes its stream',async context=>{
  const fixture=network(context,{end:false});
  context.mock.method(dns.promises,'lookup',()=>new Promise(()=>{}));syncBuiltinESMExports();
  const abortDns=new AbortController();
  const pending=scopedFetch('https://streame.center/player',{redirect:'manual',signal:abortDns.signal});
  abortDns.abort(new Error('cancel DNS'));await assert.rejects(pending,/cancel DNS/);assert.equal(fixture.opened(),0);
  context.mock.method(dns.promises,'lookup',async()=>[{address:'8.8.8.8',family:4}]);syncBuiltinESMExports();
  const abortBody=new AbortController();
  const response=await scopedFetch('https://streame.center/player',{redirect:'manual',signal:abortBody.signal});
  const text=response.text();abortBody.abort(new Error('cancel body'));await assert.rejects(text,/cancel body/);
  assert.equal(fixture.streams[0].destroyed,true);
});

test('a Request carries its cancellation signal through the probe permit wrapper',async context=>{
  const fixture=network(context);
  context.mock.method(dns.promises,'lookup',()=>new Promise(()=>{}));syncBuiltinESMExports();
  const cancellation=new AbortController();
  const input=new Request('https://streame.center/player',{redirect:'manual',signal:cancellation.signal});
  const pending=scopedFetch(input).then(()=> 'resolved',error=>error instanceof Error?error.message:'unknown');
  cancellation.abort(new Error('Request cancelled'));
  const outcome=await Promise.race([pending,new Promise<string>(resolve=>setTimeout(()=>resolve('still pending'),30))]);
  assert.equal(outcome,'Request cancelled');assert.equal(fixture.opened(),0);
});
