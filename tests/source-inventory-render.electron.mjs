import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

const targets=await(await fetch('http://127.0.0.1:9321/json/list')).json();
const target=targets.find(target=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(target,'The local Electron app must be running');
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{
  socket.addEventListener('open',resolve,{once:true});
  socket.addEventListener('error',reject,{once:true});
});
let sequence=0;
const pending=new Map();
socket.addEventListener('message',event=>{
  const message=JSON.parse(event.data),entry=pending.get(message.id);
  if(!entry)return;
  pending.delete(message.id);clearTimeout(entry.timer);
  if(message.error||message.result.exceptionDetails)entry.reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
  else entry.resolve(message.result.result.value);
});
const evaluate=expression=>new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Electron inspection timed out'));},25000);
  pending.set(id,{resolve,reject,timer});
  socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
});
async function waitFor(expression,message){
  const deadline=Date.now()+25000;
  do{
    const value=await evaluate(expression);
    if(value)return value;
    await delay(100);
  }while(Date.now()<deadline);
  assert.fail(message);
}
let openedSettings=false;
try{
  await waitFor(`document.querySelector('[role="dialog"]')===null`,'Close any existing dialog before running this check');
  await evaluate(`document.querySelector('button[aria-label="Room settings"]').click()`);
  openedSettings=true;
  await waitFor(`!![...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent.trim()==='Sources')`,'Settings must open');
  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent.trim()==='Sources').focus()`);
  await waitFor(`!!document.querySelector('.source-inventory-source-list > details')`,'The real source inventory must load');
  await evaluate(`[...document.querySelectorAll('.source-inventory [role="tab"]')].find(tab=>tab.textContent.trim()==='All').focus()`);
  await waitFor(`!![...document.querySelectorAll('.source-inventory [role="tab"][aria-selected="true"]')].find(tab=>tab.textContent.trim()==='All')`,'The All sport filter must activate');
  await waitFor(`document.querySelectorAll('.source-inventory-source-list > details').length>1`,'All sources must appear');
  const initial=await evaluate(`({sources:document.querySelectorAll('.source-inventory-source-list > details').length,
    hiddenListings:document.querySelectorAll('.source-inventory-source-list > details:not([open]) .source-inventory-source-games').length,
    nodes:document.querySelectorAll('.source-inventory *').length})`);
  console.log(JSON.stringify(initial));
  assert.equal(initial.hiddenListings,0,'Closed sources must defer their game listings');
  await evaluate(`([...document.querySelectorAll('.source-inventory-source-list > details')].find(detail=>{
    const count=detail.querySelector('summary').textContent.match(/([0-9]+) matched games/);
    return count&&Number(count[1])>0;
  })??document.querySelector('.source-inventory-source-list > details')).querySelector('summary').click()`);
  await waitFor(`!!document.querySelector('.source-inventory-source-list > details[open] .source-inventory-game-card')`,'Opening a source must show its collected game summaries');
  assert.equal(await evaluate(`document.querySelectorAll('.source-inventory-game-card:not([open]) .source-inventory-listing, .source-inventory-game-card:not([open]) ul').length`),0,'Closed games must defer their feed and listing rows');
  await evaluate(`document.querySelector('.source-inventory-game-card summary').click()`);
  await waitFor(`!!document.querySelector('.source-inventory-game-card[open] a, .source-inventory-game-card[open] button')`,'Opening a game must show its listing links');
  const opened=await evaluate(`document.querySelector('.source-inventory-game-card[open]').textContent`);
  await evaluate(`document.querySelector('.source-inventory-source-list > details[open] > summary').click()`);
  await waitFor(`document.querySelectorAll('.source-inventory-game-card').length===0`,'Closing a source must remove its unviewed game rows');
  console.log(JSON.stringify({openedGame:opened,closedSourceListings:0}));
}finally{
  try{
    if(openedSettings)await evaluate(`document.querySelector('[role="dialog"] button[data-slot="dialog-close"]')?.click()`);
  }finally{socket.close();}
}
