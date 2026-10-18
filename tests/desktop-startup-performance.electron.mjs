import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const [label='baseline',directory='.desktop-runtime/cold-start-20261017']=process.argv.slice(2);
assert.match(label,/^[a-z0-9-]+$/);
const launchedAt=Date.parse((await readFile(resolve(directory,`${label}-launched-at.txt`),'utf8')).trim());
assert.ok(Number.isFinite(launchedAt),'Record the launch timestamp before starting Electron');
const deadline=Date.now()+180000;
let room;
while(!room&&Date.now()<deadline){
  try{
    const targets=await(await fetch('http://127.0.0.1:9321/json/list',{signal:AbortSignal.timeout(1000)})).json();
    room=targets.find(target=>target.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
  }catch{}
  if(!room)await delay(100);
}
assert.ok(room,'The local Electron room must open within three minutes');
const socket=new WebSocket(room.webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let sequence=0;
  const pending=new Map();
  socket.addEventListener('message',event=>{
    const response=JSON.parse(event.data),entry=pending.get(response.id);if(!entry)return;
    pending.delete(response.id);clearTimeout(entry.timer);
    if(response.error||response.result.exceptionDetails)entry.reject(new Error(JSON.stringify(response.error??response.result.exceptionDetails)));
    else entry.resolve(response.result.result.value);
  });
  const evaluate=expression=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Startup inspection timed out'));},15000);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  });
  let page;
  do{
    page=await evaluate(`({timeOrigin:performance.timeOrigin,
      paint:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null,
      load:performance.getEntriesByType('navigation')[0]?.loadEventEnd??0,
      hydrated:!!document.querySelector('button[aria-label="Room settings"]'),
      board:!!document.querySelector('.center-game')})`);
    if(!page.hydrated||page.paint===null||!page.board)await delay(100);
  }while((!page.hydrated||page.paint===null||!page.board)&&Date.now()<deadline);
  assert.ok(page.hydrated&&page.paint!==null&&page.board,'The watch room must paint, hydrate and show its game board');
  const launchToBoardObservedMs=Date.now()-launchedAt;
  const sources=await evaluate(`fetch('/api/sources',{signal:AbortSignal.timeout(10000)}).then(response=>{
    if(!response.ok)throw new Error('Source inventory unavailable');return response.json();
  }).then(snapshot=>({at:snapshot.at,games:snapshot.games.length,
    discovered:snapshot.games.reduce((sum,game)=>sum+game.candidates.length,0),
    selectorChoices:snapshot.games.reduce((sum,game)=>sum+game.workingChoiceCount,0),
    checks:snapshot.checks})).catch(error=>({inventoryError:error.name}))`);
  const result={label,launchedAt:new Date(launchedAt).toISOString(),room:room.url,
    launchToNavigationMs:page.timeOrigin-launchedAt,
    launchToPaintMs:page.timeOrigin+page.paint-launchedAt,
    launchToBoardObservedMs,documentLoadMs:page.load,hydrated:page.hydrated,sources};
  await writeFile(resolve(directory,`${label}-startup.json`),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{socket.close();}
