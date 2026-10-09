import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProbeResources,probeHttpResponse,probeObserverLease,releaseObserverAfterClose} from '../lib/playback/probe-capacity.ts';
import {resource} from '../lib/playback/providers/public-page.ts';

test('a free transport permit never reports a queued media check',async()=>{
  const resources=createProbeResources({httpLimit:1,observerLimit:1,activeBudgetMs:65_000});
  const progress:string[]=[];
  await resources.run(new AbortController().signal,event=>progress.push(event.kind),async signal=>{
    const response=await probeHttpResponse(signal,async()=>new Response('ok'));
    assert.equal(await response.text(),'ok');
  });
  assert.deepEqual(progress,['active']);
});

test('observer work holds four slots while eight direct HTTP operations advance',async()=>{
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
  const observers:Array<()=>void>=[];
  const browser=Array.from({length:4},()=>resources.run(new AbortController().signal,()=>{},async()=>{
    const release=await probeObserverLease(new AbortController().signal);
    observers.push(release);
    await new Promise<void>(resolve=>{const finish=release;observers[observers.length-1]=()=>{finish();resolve();};});
  }));
  for(let attempt=0;observers.length<4&&attempt<100;attempt++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(observers.length,4);
  let active=0,peak=0;
  const direct=Array.from({length:8},()=>resources.run(new AbortController().signal,()=>{},async()=>{
    const response=await probeHttpResponse(new AbortController().signal,async()=>{
      active++;peak=Math.max(peak,active);
      await new Promise<void>(resolve=>setImmediate(resolve));
      active--;
      return new Response('ok');
    });
    assert.equal(await response.text(),'ok');
  }));
  await Promise.all(direct);
  assert.equal(peak,8);
  observers.forEach(release=>release());
  await Promise.all(browser);
});

test('finite provider errors release unread HTTP bodies before the next check',async()=>{
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
  await Promise.all(Array.from({length:8},()=>resources.run(new AbortController().signal,()=>{},async signal=>{
    const response=await probeHttpResponse(signal,async()=>new Response('invalid',{status:403}));
    assert.equal(response.status,403);
    throw new Error('Provider rejected the response before consuming the body');
  }).catch(()=>{})));
  let entered=false;
  await resources.run(new AbortController().signal,()=>{},async signal=>{
    const response=await probeHttpResponse(signal,async()=>{entered=true;return new Response('ok');});
    assert.equal(await response.text(),'ok');
  });
  assert.equal(entered,true);
});

test('the active budget bounds stalled provider work without a transport',async()=>{
  const resources=createProbeResources({httpLimit:1,observerLimit:1,activeBudgetMs:25});
  await assert.rejects(resources.run(new AbortController().signal,()=>{},async()=>new Promise<void>(()=>{})),
    error=>error instanceof Error&&error.name==='TimeoutError');
});

test('time spent waiting for a real permit does not spend the active budget',async()=>{
  const resources=createProbeResources({httpLimit:1,observerLimit:1,activeBudgetMs:25});
  let releaseWork:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{releaseWork=resolve;});
  let entered=false;
  const first=resources.run(new AbortController().signal,()=>{},async signal=>{
    const release=await probeObserverLease(signal);
    entered=true;
    try{await gate;}finally{release();}
  }).catch(()=>{});
  for(let index=0;!entered&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(entered,true);
  let granted=false;
  const progress:string[]=[];
  const second=resources.run(new AbortController().signal,event=>progress.push(event.kind),async signal=>{
    const release=await probeObserverLease(signal);
    granted=true;
    release();
  });
  await new Promise<void>(resolve=>setTimeout(resolve,60));
  assert.equal(granted,false);
  assert.deepEqual(progress,['waiting']);
  releaseWork();
  await Promise.all([first,second]);
  assert.equal(granted,true);
  assert.deepEqual(progress,['waiting','active']);
});

test('playlist header deadline begins after the HTTP permit is granted',async()=>{
  const resources=createProbeResources({httpLimit:1,observerLimit:1,activeBudgetMs:65_000});
  let releaseFirst:()=>void=()=>{};
  let firstEntered=false;
  const first=resources.run(new AbortController().signal,()=>{},async signal=>{
    const response=await probeHttpResponse(signal,async()=>{
      firstEntered=true;
      await new Promise<void>(resolve=>{releaseFirst=resolve;});
      return new Response('first');
    });
    await response.text();
  });
  for(let index=0;!firstEntered&&index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(firstEntered,true);
  const playlist=resource(new URL('https://media.example.com/master.m3u8'),
    new URL('https://event.example.com/watch'),'playlist',(_url,signal,_headers,timeoutMs)=>
      probeHttpResponse(signal,async active=>{
        active.throwIfAborted();
        return new Response('#EXTM3U\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}});
      },timeoutMs));
  const second=resources.run(new AbortController().signal,()=>{},async signal=>{
    const response=await playlist.read({signal});
    assert.equal(await new Response(response.body).text(),'#EXTM3U\n');
  });
  await new Promise<void>(resolve=>setTimeout(resolve,10_100));
  releaseFirst();
  await Promise.all([first,second]);
});

test('an inner HTTP timeout rejects a partial response body',async()=>{
  const resources=createProbeResources({httpLimit:1,observerLimit:1,activeBudgetMs:1000});
  await resources.run(new AbortController().signal,()=>{},async signal=>{
    const response=await probeHttpResponse(signal,async()=>new Response(new ReadableStream<Uint8Array>({
      start(controller){controller.enqueue(new TextEncoder().encode('#EXTM3U\n'));},
    })),20);
    await assert.rejects(response.text(),error=>error instanceof Error&&error.name==='TimeoutError');
  });
});

test('failed observer close acknowledgements retain slots until the idle horizon',async()=>{
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:1000});
  let closes=0;
  await Promise.all(Array.from({length:4},()=>resources.run(new AbortController().signal,()=>{},async signal=>{
    const release=await probeObserverLease(signal);
    releaseObserverAfterClose(async()=>{closes++;return false;},release,10,70);
  })));
  let granted=false;
  const fifth=resources.run(new AbortController().signal,()=>{},async signal=>{
    const release=await probeObserverLease(signal);
    granted=true;
    release();
  });
  await new Promise<void>(resolve=>setTimeout(resolve,30));
  assert.equal(granted,false);
  assert.ok(closes>=4);
  await fifth;
  assert.equal(granted,true);
});
