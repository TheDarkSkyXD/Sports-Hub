import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {isPublicAddress,publicHttpsRequest,resource} from '../lib/playback/providers/public-page.ts';

const MiB=1024*1024;
for(const range of [undefined,'bytes=0-'])test('a progressive '+(range??'continuous response')+' exceeds finite limits while respecting rolling traffic and idle bounds',async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout']});
  const inputs:{headers:Record<string,string>;stream:PassThrough}[]=[];
  context.mock.method(https,'request',(...args:unknown[])=>{
    const options=args[1],callback=args[2];
    assert.ok(options&&typeof options==='object'&&'headers'in options&&options.headers&&typeof options.headers==='object'&&typeof callback==='function');
    const headers=Object.fromEntries(Object.entries(options.headers).map(([name,value])=>{assert.equal(typeof value,'string');return [name,String(value)];}));
    const stream=Object.assign(new PassThrough(),{headers:{'content-type':'video/mp4','content-length':String(256*MiB)},statusCode:headers.range?206:200});
    const outgoing=Object.assign(new EventEmitter(),{
      end(){queueMicrotask(()=>callback(stream));},destroy(error?:Error){stream.destroy(error);this.emit('error',error);},
    });
    inputs.push({headers,stream});
    return outgoing;
  });
  syncBuiltinESMExports();
  try{
    const requester=(url:URL,signal:AbortSignal,headers:Headers,timeoutMs?:number,policy?:Parameters<typeof publicHttpsRequest>[5])=>
      publicHttpsRequest(url,signal,headers,async()=>[{address:'8.8.8.8',family:4}],timeoutMs,policy);
    const video=resource(new URL('https://cdn.example/game.mp4'),new URL('https://player.example/game'),'media',requester,'Mozilla/5.0','progressive');
    const read=await video.read({signal:new AbortController().signal,range});
    assert.equal(read.status,range?206:200);assert.equal(read.contentLength,String(256*MiB));assert.equal(inputs[0].headers.range,range);
    assert.ok(read.body);const reader=read.body.getReader();
    for(let index=0;index<140;index++){
      inputs[0].stream.write(Buffer.alloc(MiB));
      assert.equal((await reader.read()).value?.byteLength,MiB);
      context.mock.timers.tick(1000);
    }
    inputs[0].stream.write(Buffer.alloc(MiB));
    await new Promise<void>(resolve=>setImmediate(resolve));
    context.mock.timers.tick(31_000);
    assert.equal((await reader.read()).value?.byteLength,MiB);
    inputs[0].stream.write(Buffer.alloc(MiB));
    assert.equal((await reader.read()).value?.byteLength,MiB);
    await reader.cancel();context.mock.timers.tick(60_000);
    const burst=await video.read({signal:new AbortController().signal,range});assert.ok(burst.body);
    const burstReader=burst.body.getReader();
    for(let index=0;index<150;index++){
      inputs[1].stream.write(Buffer.alloc(MiB));
      if(index<128)await burstReader.read();
      else{await assert.rejects(burstReader.read(),/byte budget/);break;}
    }
    context.mock.timers.tick(60_000);
    const stalled=await video.read({signal:new AbortController().signal,range});assert.ok(stalled.body);
    const stalledRead=stalled.body.getReader().read();context.mock.timers.tick(30_001);
    await assert.rejects(stalledRead,/timed out/);
    await assert.rejects(requester(new URL('https://cdn.example/segment.ts'),new AbortController().signal,new Headers(),30000),/too large/);
  }finally{context.mock.restoreAll();syncBuiltinESMExports();}
});

test('public progressive transport rejects special and mapped addresses before connecting',async()=>{
  for(const address of ['2001:2::1','2001:20::1','3fff::1','::ffff:8.8.8.8','::ffff:127.0.0.1','169.254.169.254','100.64.0.1'])assert.equal(isPublicAddress(address),false,address);
  for(const address of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true,address);
});


