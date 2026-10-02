import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { publicHttpsRequest, sportsurgeUrl } from '../lib/playback/providers/sportsurge-v2.ts';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const targetUrl = process.argv[2];
const verifyConcurrency = process.argv.includes('--concurrency');
if (!targetUrl) throw new Error('Pass one current Sportsurge provider destination URL');
const token = 'observer-smoke-token';
const env = { ...process.env, SUNDAY_ROOM_COLLECTOR_ORIGIN:'http://127.0.0.1:3100', SUNDAY_ROOM_CONTROL_TOKEN:token,
  SUNDAY_ROOM_OBSERVER_DEBUG:process.env.SUNDAY_ROOM_OBSERVER_DEBUG || '0' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(await prepareDevelopmentElectron(),[resolve('desktop/sportsurge-sidecar.cjs')],{
  cwd:process.cwd(),env,stdio:['ignore','inherit','ignore','ipc'],windowsHide:true,
});
async function pinnedRead(value, referer, userAgent) {
  let url = sportsurgeUrl(value);
  assert.ok(url, 'unsafe observed media URL');
  for (let redirect = 0; redirect <= 3; redirect++) {
    const headers = new Headers({ 'User-Agent':userAgent, Accept:'*/*',
      Referer:referer, Origin:new URL(referer).origin });
    const response = await publicHttpsRequest(url, AbortSignal.timeout(45000), headers, undefined, 30000);
    if (response.status < 300 || response.status > 399) return { url, response };
    const location = response.headers.get('location');
    await response.body?.cancel();
    assert.ok(location, 'provider redirect has no location');
    url = sportsurgeUrl(new URL(location,url).href);
    assert.ok(url, 'provider redirect is unsafe');
  }
  assert.fail('provider redirected too many times');
}
try {
  const origin = await new Promise((resolveReady,reject) => {
    const timer = setTimeout(() => reject(new Error('sidecar readiness timeout')),15000);
    child.once('error',reject);
    child.once('exit',code => reject(new Error(`sidecar exited ${code}`)));
    child.on('message',message => {
      if (message?.kind === 'ready') { clearTimeout(timer); resolveReady(message.origin); }
    });
  });
  const denied = await fetch(`${origin}/observe`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(denied.status,401);
  console.log('unauthorized',denied.status);
  const privateHost = await fetch(`${origin}/observe`,{
    method:'POST',headers:{'content-type':'application/json','x-sunday-control-token':token},
    body:JSON.stringify({url:'https://127.0.0.1/private'}),
  });
  assert.equal(privateHost.status,400);
  const observe = (url, signal, purpose='playback') => fetch(`${origin}/observe`,{
    method:'POST',headers:{'content-type':'application/json','x-sunday-control-token':token},
    body:JSON.stringify({url,purpose}),signal,
  });
  const pending = Array.from({length:verifyConcurrency ? 4 : 1}, () => {
    const abort = new AbortController();
    const operation = {abort,status:null,request:null};
    operation.request = observe(new URL('/__sunday_room_observer_capacity__',targetUrl).href,abort.signal)
      .then(response => { operation.status=response.status; return response; }).catch(() => null);
    return operation;
  });
  await new Promise(resolve => setTimeout(resolve,1000));
  if (verifyConcurrency) {
    assert.ok(pending.every(operation=>operation.status===null),'capacity probes must still occupy all four slots');
    const full = await observe(targetUrl,AbortSignal.timeout(5000));
    assert.equal(full.status,429,'a fifth observation must respect the four-slot limit');
    console.log('four occupied slots reject fifth',full.status);
  }
  pending[0].abort.abort();
  await pending[0].request;
  await new Promise(resolve => setTimeout(resolve,300));
  for (const operation of pending) operation.abort.abort();
  await Promise.all(pending.map(operation => operation.request));
  await new Promise(resolve => setTimeout(resolve,300));
  if (verifyConcurrency) {
    const capacityUrl=new URL('/__sunday_room_observer_capacity__',targetUrl).href;
    const probes=Array.from({length:4},()=>{
      const abort=new AbortController();
      const probe={abort,status:null,request:null};
      probe.request=observe(capacityUrl,abort.signal,'probe')
        .then(response=>{ probe.status=response.status; return response; }).catch(()=>null);
      return probe;
    });
    await new Promise(resolve=>setTimeout(resolve,1000));
    assert.ok(probes.every(probe=>probe.status===null),'background probes must remain pending before preemption');
    const occupied=await observe(capacityUrl,AbortSignal.timeout(5000),'probe');
    assert.equal(occupied.status,429,'four background probes must occupy all slots before preemption');
    const foregroundAbort=new AbortController();
    const foreground=observe(capacityUrl,foregroundAbort.signal).catch(()=>null);
    try {
      const preempted=await Promise.race([
        ...probes.map(probe=>probe.request),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('foreground did not preempt a probe')),5000)),
      ]);
      assert.equal(preempted?.status,503,'foreground playback must defer a background probe');
      const busy=await observe(capacityUrl,AbortSignal.timeout(5000),'probe');
      assert.equal(busy.status,429,'background probes cannot evict foreground playback');
      console.log('foreground preemption',preempted.status,'background capacity',busy.status);
    } finally {
      foregroundAbort.abort();
      for(const probe of probes)probe.abort.abort();
      await Promise.all([foreground,...probes.map(probe=>probe.request)]);
    }
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  const started = Date.now();
  const response = await observe(targetUrl,AbortSignal.timeout(25000));
  const result = response.ok ? await response.json() : null;
  console.log('observe',response.status,Date.now()-started,result ? {mediaHost:new URL(result.url).hostname,refererHost:new URL(result.referer).hostname} : null);
  assert.equal(response.status,200);
  assert.ok(result);
  if (verifyConcurrency) {
    const simultaneous = await Promise.all(Array.from({length:4},async () => {
      const response = await observe(targetUrl,AbortSignal.timeout(25000));
      assert.equal(response.status,200,'all four room tiles must resolve concurrently');
      const result = await response.json();
      assert.ok(sportsurgeUrl(result.url));
      return {status:response.status,mediaHost:new URL(result.url).hostname};
    }));
    console.log('four simultaneous observations',simultaneous);
  }
  if (result) {
    let target = result.url;
    let completeSegment = false;
    for (let depth=0;depth<5;depth++) {
      const startedMedia=Date.now();
      const { url, response:media } = await pinnedRead(target,result.referer,result.userAgent);
      console.log('media headers',depth,url.hostname,media.status,media.headers.get('content-type'),Date.now()-startedMedia);
      assert.equal(media.status,200,'provider media request failed');
      if (!/mpegurl/i.test(media.headers.get('content-type') || '')) {
        const body=await media.arrayBuffer();
        console.log('media body',depth,body.byteLength,Date.now()-startedMedia);
        assert.ok(body.byteLength > 0);
        completeSegment = true;
        break;
      }
      const text = await media.text();
      console.log('media body',depth,Buffer.byteLength(text),Date.now()-startedMedia);
      assert.ok(text.startsWith('#EXTM3U'));
      const lines=text.split(/\r?\n/);
      const child = lines.find(line => line && !line.startsWith('#'));
      assert.ok(child,'provider playlist has no child resource');
      console.log('segment duration',lines.find(line => line.startsWith('#EXTINF:')) || 'variant playlist');
      target = new URL(child,url).href;
    }
    assert.ok(completeSegment,'provider did not return a complete video segment');
  }
} finally {
  if (child.connected) child.send({kind:'stop'});
  await new Promise(resolveExit => { child.once('exit',resolveExit); setTimeout(resolveExit,3000); });
}
