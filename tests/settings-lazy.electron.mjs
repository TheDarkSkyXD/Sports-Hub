import assert from 'node:assert/strict';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const directory=resolve('.scratch/performance/followup-2026-10-18/home');
await mkdir(directory,{recursive:true});
const current=JSON.parse(await readFile('.desktop-runtime/local-builds/current.json','utf8'));
const staticRoot=resolve('.desktop-runtime/local-builds',current.id,'static');
const markers={sources:'source-inventory-source-list',updates:'update-panel-source-row'};
const chunks={sources:[],updates:[]};
for(const path of await readdir(staticRoot,{recursive:true})){
  if(!path.endsWith('.js'))continue;
  const source=await readFile(resolve(staticRoot,path),'utf8');
  for(const [name,marker] of Object.entries(markers))
    if(source.includes(marker))chunks[name].push('/_next/static/'+path.replaceAll('\\','/'));
}
assert.ok(chunks.sources.length&&chunks.updates.length,'The compiled settings modules must be identifiable');
const targets=await(await fetch('http://127.0.0.1:9321/json/list')).json();
const target=targets.find(target=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(target,'The existing compiled Electron app must be running');
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
let sequence=0;
const pending=new Map(),errors=[];
socket.addEventListener('message',event=>{
  const message=JSON.parse(event.data);
  if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);
  const entry=pending.get(message.id);if(!entry)return;
  pending.delete(message.id);clearTimeout(entry.timer);
  if(message.error||message.result.exceptionDetails)entry.reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
  else entry.resolve(message.result);
});
const send=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},20000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
});
const evaluate=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})).result.value;
async function wait(expression,message){
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){if(await evaluate(expression))return;await delay(100);}
  assert.fail(message);
}
async function click(expression){
  if(process.argv.includes('--dom-input')){await evaluate(`(()=>{const element=${expression};element.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true}));element.focus();element.click();})()`);return;}
  const point=await evaluate(`(()=>{const element=${expression};if(!element)throw new Error('Missing control');const rect=element.getBoundingClientRect();if(rect.width===0||rect.height===0)throw new Error('Control is hidden');return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
}
const settings=`document.querySelector('[aria-label="Room settings"]')`;
const close=`document.querySelector('[role="dialog"] [data-slot="dialog-close"]')`;
const tab=name=>`[...document.querySelectorAll('[role="dialog"] [role="tab"]')].find(tab=>tab.textContent.trim()===${JSON.stringify(name)})`;
const paths=()=>evaluate(`performance.getEntriesByType('resource').map(entry=>new URL(entry.name).pathname)`);
const loaded=(name,resources)=>chunks[name].filter(path=>resources.includes(path));
async function screenshot(name){const capture=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(directory,name+'.png'),Buffer.from(capture.data,'base64'));}
async function mainEvaluate(expression){
  const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
  const inspector=new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{inspector.addEventListener('open',resolve,{once:true});inspector.addEventListener('error',reject,{once:true});});
  try{
    const response=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Main-process focus check timed out')),10000);
      inspector.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message)));else resolve(message.result.result.value);});
    });
    inspector.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
    return await response;
  }finally{inspector.close();}
}
let opened=false;
const result={build:current.id,chunks,inputMode:process.argv.includes('--dom-input')?'dom-fallback':'cdp'};
if(process.argv.includes('--dom-input'))result.inputLimit='CDP mouse events did not reach the main document after reload, including after explicit room and main WebContents focus.';
let nativeFocus;
try{
  if(process.argv.includes('--focus-room')){
    nativeFocus=await mainEvaluate(`(()=>{const e=process.mainModule.require('electron'),room=e.BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===${JSON.stringify(target.url)});if(!room)throw new Error('Room window unavailable');const previous={id:room.id,focused:room.isFocused()};room.focus();room.webContents.focus();return {...previous,focusedNow:room.isFocused(),contentsFocusedNow:room.webContents.isFocused()};})()`);
    result.nativeFocus=nativeFocus;
  }
  await send('Runtime.enable');await send('Page.enable');
  await wait(`!!document.querySelector('[aria-label="Room settings"]')`,'The watch room must load');
  assert.equal(await evaluate(`!!document.querySelector('[role="dialog"]')`),false,'Run against the fresh app before opening Settings');
  const savedRoom=await evaluate(`localStorage.getItem('sunday-room:v1')`);
  const savedUpdates=await evaluate(`window.sundayDesktop.get().then(status=>({source:status.source,preferences:status.preferences}))`);
  if(!process.argv.includes('--fresh-existing')&&!process.argv.includes('--no-reload')){
    const previousOrigin=await evaluate(`performance.timeOrigin`);
    await send('Page.reload');
    await wait(`performance.timeOrigin>${previousOrigin}&&document.readyState==='complete'`,'The authorized reload must finish');
  }
  await wait(`!!document.querySelector('.app.desktop [aria-label="Room settings"]')`,'The compiled watch room must finish hydration before interaction');
  const initial=await paths();
  result.initial={sources:loaded('sources',initial),updates:loaded('updates',initial)};
  assert.deepEqual(result.initial,{sources:[],updates:[]},'Settings modules must be absent from fresh renderer resources');
  await click(settings);opened=true;
  await wait(`!!document.querySelector('[role="dialog"]')`,'Settings must open');
  await wait(`(${tab('General')})?.getAttribute('aria-selected')==='true'`,'Settings must initially show General');
  const general=await paths();
  assert.equal(loaded('sources',general).length+loaded('updates',general).length,0,'General must not load the optional panels');
  await click(tab('Sources'));
  await wait(`!!document.querySelector('.source-inventory-result')`,'The compiled source inventory must show its real result');
  const sources=await paths();
  result.sources={chunks:loaded('sources',sources),summary:await evaluate(`document.querySelector('.source-inventory-result').textContent`)};
  assert.ok(result.sources.chunks.length,'Opening Sources must load its compiled module');
  await screenshot('compiled-sources');
  await click(tab('Updates'));
  await wait(`!!document.querySelector('.update-panel-versions')`,'The compiled update panel must load its actual status');
  const updates=await paths();
  result.updates={chunks:loaded('updates',updates),versions:await evaluate(`document.querySelector('.update-panel-versions').textContent`)};
  assert.ok(result.updates.chunks.length,'Opening Updates must load its compiled module');
  assert.equal(await evaluate(`document.querySelector('#update-source-url').readOnly`),false,'This draft check requires the development update field');
  await wait(`document.querySelector('#update-source-url')?.disabled===false`,'The update-source field must be ready for an unsaved draft');
  await screenshot('compiled-updates');
  await evaluate(`(()=>{const form=document.querySelector('.update-panel-source');form.dataset.verificationSubmits='0';form.addEventListener('submit',()=>{form.dataset.verificationSubmits=String(Number(form.dataset.verificationSubmits)+1);});})()`);
  await click(`document.querySelector('#update-source-url')`);
  const draft='Unsaved verification draft';
  if(process.argv.includes('--dom-input')){
    await evaluate(`(()=>{const input=document.querySelector('#update-source-url');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(draft)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  }else{
    await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await send('Input.insertText',{text:draft});
  }
  await wait(`document.querySelector('#update-source-url')?.value===${JSON.stringify(draft)}`,'The unsaved draft must appear');
  await click(tab('General'));
  await wait(`(${tab('General')})?.getAttribute('aria-selected')==='true'`,'General must activate');
  await click(tab('Updates'));
  await wait(`(${tab('Updates')})?.getAttribute('aria-selected')==='true'`,'Updates must reactivate');
  assert.equal(await evaluate(`document.querySelector('#update-source-url').value`),draft,'Switching tabs must preserve the unsaved draft');
  assert.equal(await evaluate(`document.querySelector('.update-panel-source').dataset.verificationSubmits`),'0','The draft must never be submitted');
  result.draftPreserved=true;
  await click(close);opened=false;
  await wait(`!document.querySelector('[role="dialog"]')`,'Settings must close');
  await click(settings);opened=true;
  await wait(`!!document.querySelector('[role="dialog"]')`,'Settings must reopen');
  await delay(100);
  await click(tab('Updates'));
  await wait(`(${tab('Updates')})?.getAttribute('aria-selected')==='true'&&!!document.querySelector('.update-panel-versions')`,'Reopening Updates must load its saved status');
  assert.equal(await evaluate(`document.querySelector('#update-source-url').value`),savedUpdates.source.url,'Closing Settings must reset the unsaved draft');
  result.draftResetOnClose=true;
  await click(close);opened=false;
  await wait(`!document.querySelector('[role="dialog"]')`,'Settings must finish closed');
  assert.equal(await evaluate(`localStorage.getItem('sunday-room:v1')`),savedRoom,'Settings inspection must preserve saved room preferences');
  assert.deepEqual(await evaluate(`window.sundayDesktop.get().then(status=>({source:status.source,preferences:status.preferences}))`),savedUpdates,'Settings inspection must preserve the persisted update configuration');
  assert.deepEqual(errors,[],'The compiled flow must produce no renderer exceptions');
  result.savedRoomPreserved=true;result.savedUpdatesPreserved=true;result.errors=errors;
  assert.equal(await evaluate(`!!document.querySelector('.workspace')`),true,'Verification must leave the watch room open');
  await writeFile(resolve(directory,'compiled-lazy.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}catch(error){
  const state=await evaluate(`({tabs:[...document.querySelectorAll('[role="dialog"] [role="tab"]')].map(tab=>({name:tab.textContent,selected:tab.getAttribute('aria-selected')})),inventory:document.querySelector('.source-inventory')?.textContent,updates:document.querySelector('.update-panel')?.textContent})`).catch(()=>null);
  await writeFile(resolve(directory,'compiled-lazy.json'),JSON.stringify({...result,error:String(error),state,errors},null,2)+'\n');throw error;
}
finally{
  try{if(opened&&await evaluate(`!!(${close})`))await click(close);}finally{
    socket.close();
    if(nativeFocus&&!nativeFocus.focused)await mainEvaluate(`process.mainModule.require('electron').BrowserWindow.fromId(${nativeFocus.id})?.blur()`);
  }
}
