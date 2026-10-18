import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const options=new Map();
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index],value=process.argv[index+1];
  assert.ok(['--port','--seconds','--output','--trace'].includes(key)&&value,'Expected named measurement options');
  options.set(key,value);
}
const port=Number(options.get('--port')??9321);
const seconds=Number(options.get('--seconds')??30);
const tracing=options.get('--trace')==='checks';
assert.ok(Number.isInteger(port)&&port>0&&port<65536);
assert.ok(Number.isInteger(seconds)&&seconds>=5&&seconds<=300);
const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const room=targets.find(target=>target.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(room,'The local Electron watch room must be running');
const socket=new WebSocket(room.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{
  socket.addEventListener('open',resolve,{once:true});
  socket.addEventListener('error',reject,{once:true});
});
let sequence=0;
const pending=new Map();
socket.addEventListener('message',event=>{
  const response=JSON.parse(event.data),entry=pending.get(response.id);
  if(!entry)return;
  pending.delete(response.id);clearTimeout(entry.timer);
  if(response.error)entry.reject(new Error(response.error.message));
  else entry.resolve(response.result);
});
function command(method,params={},sessionId){
  return new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`));},20000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));
  });
}
async function sample(){
  const result=await command('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
    let snapshot={games:[]},inventoryError=null;
    if(!${tracing}){
      try{
        const response=await fetch('/api/sources',{signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error('Source inventory is unavailable');
        snapshot=await response.json();
      }catch(error){inventoryError=error.name;}
    }
    return {at:Date.now(),games:snapshot.games.map(game=>({id:game.gameId,workingChoices:game.workingChoiceCount,
      feeds:game.candidates.map(candidate=>({id:candidate.id,sources:candidate.sourceIds,availability:candidate.availability}))})),
      inventoryError,
      videos:[...document.querySelectorAll('video')].map(video=>({time:video.currentTime,
        paused:video.paused,width:video.videoWidth,readyState:video.readyState,
        frames:video.getVideoPlaybackQuality().totalVideoFrames,
        dropped:video.getVideoPlaybackQuality().droppedVideoFrames}))};
  })()`});
  assert.ok(!result.exceptionDetails,'Could not sample Electron feed checks');
  const {targetInfos}=await command('Target.getTargets');
  const verifierUrl=new URL('/internal/playback-verifier',room.url).href;
  const verifier=targetInfos.find(target=>target.type==='page'&&target.url===verifierUrl);
  let checker={slots:0,active:0,checks:[],players:[]};
  if(verifier){
    const {sessionId}=await command('Target.attachToTarget',{targetId:verifier.targetId,flatten:true});
    try{
      const state=await command('Runtime.evaluate',{returnByValue:true,expression:`(()=>{
        if(${tracing}&&window.__sundayVerify&&!window.__feedCheckTrace){
          const bridge=window.__sundayVerify,original=bridge.assign,checks=[];
          const wrapped=function(id,url){
            const address=new URL(url),check={id,gameId:address.pathname.split('/')[3],
              candidateId:address.searchParams.get('candidate'),startedAt:Date.now()};
            checks.push(check);
            return original.call(this,id,url).then(result=>{
              Object.assign(check,{finishedAt:Date.now(),kind:result.kind,reason:result.reason,
                phase:result.phase,retryAfterMs:result.retryAfterMs,timings:result.timings});
              return result;
            },error=>{Object.assign(check,{finishedAt:Date.now(),kind:'error'});throw error;});
          };
          window.__feedCheckTrace={original,wrapped,checks};bridge.assign=wrapped;
        }
        const players=[...document.querySelectorAll('video')].map(video=>{
          let fiber=video[Object.keys(video).find(key=>key.startsWith('__reactFiber$'))],hls,url;
          while(fiber){
            url??=fiber.memoizedProps?.feed?.url;
            let hook=fiber.memoizedState;
            while(hook){const ref=hook.memoizedState?.current;
              if(ref?.config&&ref?.streamController)hls=ref;hook=hook.next;}
            fiber=fiber.return;
          }
          const address=url?new URL(url):null;
          return {gameId:address?.pathname.split('/')[3],candidateId:address?.searchParams.get('candidate'),
            width:video.videoWidth,height:video.videoHeight,readyState:video.readyState,
            frames:video.getVideoPlaybackQuality().totalVideoFrames,state:hls?.streamController?.state,
            levels:hls?.levels?.length,currentLevel:hls?.currentLevel,
            bufferedSeconds:video.buffered.length?video.buffered.end(video.buffered.length-1)-video.currentTime:0};
        });
        return {slots:document.querySelector('main')?.children.length??0,active:players.length,
          checks:window.__feedCheckTrace?.checks??[],players};
      })()`},sessionId);
      assert.ok(!state.exceptionDetails,'Could not inspect the Electron playback checker');
      checker=state.result.value;
    }finally{await command('Target.detachFromTarget',{sessionId});}
  }
  return {...result.result.value,checker};
}
const run=promisify(execFile);
async function resources(){
  const binary=resolve('.desktop-runtime/electron/electron.exe').replaceAll("'","''");
  const {stdout}=await run('powershell.exe',['-NoProfile','-Command',
    `@(Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${binary}' } | ForEach-Object { [pscustomobject]@{id=$_.Id;cpu=$_.CPU;bytes=$_.WorkingSet64} }) | ConvertTo-Json -Compress`],{windowsHide:true});
  return JSON.parse(stdout);
}
try{
  const beforeResources=await resources(),samples=[await sample()];
  const started=performance.now();
  while(performance.now()-started<seconds*1000){
    await delay(Math.min(2000,seconds*1000-(performance.now()-started)));
    samples.push(await sample());
  }
  const elapsedSeconds=(performance.now()-started)/1000;
  const afterResources=await resources();
  const initial=new Map(beforeResources.map(item=>[item.id,item.cpu]));
  const cpuCorePercent=afterResources.reduce((sum,item)=>sum+100*(item.cpu-(initial.get(item.id)??item.cpu))/elapsedSeconds,0);
  const completed=new Set();
  for(const sample of samples)for(const game of sample.games)for(const feed of game.feeds){
    const state=feed.availability;
    if('checkedAt' in state&&state.checkedAt>samples[0].at)
      completed.add(`${game.id}/${feed.id}/${state.checkedAt}`);
  }
  const counts=samples.map(sample=>{
    const feeds=sample.games.flatMap(game=>game.feeds);
    return {at:sample.at,games:sample.games.length,feeds:feeds.length,
      selectorChoices:sample.games.reduce((sum,game)=>sum+game.workingChoices,0),
      gamesWithChoices:sample.games.filter(game=>game.workingChoices>0).length,
      checker:{slots:sample.checker.slots,active:sample.checker.active},
      playable:feeds.filter(feed=>feed.availability.kind==='playable').length,
      active:feeds.filter(feed=>feed.availability.kind==='checking'&&feed.availability.progress.kind==='active').length,
      queued:feeds.filter(feed=>feed.availability.kind==='checking'&&feed.availability.progress.kind==='queued').length};
  });
  const before=samples[0],after=samples.at(-1);
  assert.equal(after.videos.length,before.videos.length,'The room workload must remain unchanged');
  for(const [index,video] of before.videos.entries())if(!video.paused&&video.width>0){
    const current=after.videos[index];
    assert.ok(!current.paused&&current.width>0&&current.frames>video.frames,
      `Room stream ${index+1} must keep presenting video while feeds are checked`);
  }
  const summary={elapsedSeconds,completedFeedUpdates:completed.size,feedUpdatesPerMinute:60*completed.size/elapsedSeconds,
    peakActiveCheckerSlots:Math.max(...counts.map(sample=>sample.checker.slots)),
    peakMountedDirectVideos:Math.max(...counts.map(sample=>sample.checker.active)),cpuCorePercent,
    workingSetMB:afterResources.reduce((sum,item)=>sum+item.bytes/1048576,0),
    roomStreams:after.videos.length,inventoryReadErrors:samples.filter(sample=>sample.inventoryError).length,
    before:counts[0],after:counts.at(-1)};
  const checks=after.checker.checks;
  if(tracing)summary.trials={started:checks.length,completed:checks.filter(check=>check.finishedAt).length,
    playable:checks.filter(check=>check.kind==='playable').length,
    deferred:checks.filter(check=>check.kind==='deferred').length,
    unavailable:checks.filter(check=>check.kind==='unavailable').length};
  if(options.has('--output')){
    const output=resolve(options.get('--output'));
    await mkdir(dirname(output),{recursive:true});
    await writeFile(output,JSON.stringify({summary,counts,roomBefore:before.videos,roomAfter:after.videos,
      ...(tracing?{checks,checkerSamples:samples.map(sample=>({at:sample.at,players:sample.checker.players})),
        sources:after.games.map(game=>({id:game.id,feeds:game.feeds.map(feed=>({id:feed.id,sources:feed.sources}))}))}:{})},null,2)+'\n');
  }
  console.log(JSON.stringify(summary));
}finally{
  if(tracing){
    const {targetInfos}=await command('Target.getTargets');
    const verifier=targetInfos.find(target=>target.url===new URL('/internal/playback-verifier',room.url).href);
    if(verifier){
      const {sessionId}=await command('Target.attachToTarget',{targetId:verifier.targetId,flatten:true});
      try{await command('Runtime.evaluate',{expression:`(()=>{
        const trace=window.__feedCheckTrace;
        if(trace&&window.__sundayVerify?.assign===trace.wrapped)window.__sundayVerify.assign=trace.original;
        delete window.__feedCheckTrace;
      })()`},sessionId);}finally{await command('Target.detachFromTarget',{sessionId});}
    }
  }
  socket.close();
}
