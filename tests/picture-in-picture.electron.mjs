import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

assert.equal(process.platform,'win32','Native PiP close verification requires Windows.');
const origin=process.argv.find(value=>value.startsWith('--origin='))?.slice(9)||'http://127.0.0.1:51931';
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d{1,5}$/);
const run=promisify(execFile);
const targets=await fetch('http://127.0.0.1:9331/json/list').then(response=>response.json());
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
let nextId=1;
const pending=new Map();
socket.addEventListener('message',event=>{
  const reply=JSON.parse(event.data),request=pending.get(reply.id);
  if(!request)return;
  pending.delete(reply.id);clearTimeout(request.timer);
  if(reply.error)request.reject(new Error(reply.error.message));
  else if(reply.result.exceptionDetails)request.reject(new Error(reply.result.exceptionDetails.exception?.description??reply.result.exceptionDetails.text));
  else request.resolve(reply.result.result.value);
});
function evaluate(expression) {
  const id=nextId++;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Electron evaluation timed out.'));},15000);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  });
}
const page=expression=>evaluate(`(async()=>{const {BrowserWindow}=process.mainModule.require('electron');const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===${JSON.stringify(`${origin}/`)});if(!window)throw new Error('Running development app not found.');return window.webContents.executeJavaScript(${JSON.stringify(expression)},true);})()`);
async function until(expression) {
  for(let attempt=0;attempt<50;attempt++){
    if(await page(expression))return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`Player did not reach ${expression}`);
}
const pid=await evaluate('process.pid');
const closePip=`Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Text;
public static class PipWindow{public delegate bool Callback(IntPtr handle,IntPtr parameter);[DllImport("user32.dll")]public static extern bool EnumWindows(Callback callback,IntPtr parameter);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint id);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr handle,StringBuilder text,int count);[DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr handle,uint message,IntPtr wparam,IntPtr lparam);}
'@
$script:pipHandle=[IntPtr]::Zero
[PipWindow]::EnumWindows({param($handle,$parameter);[uint32]$windowPid=0;[PipWindow]::GetWindowThreadProcessId($handle,[ref]$windowPid)|Out-Null;if($windowPid -eq ${pid}){$title=New-Object System.Text.StringBuilder 256;[PipWindow]::GetWindowText($handle,$title,256)|Out-Null;if($title.ToString() -match '^Picture.in.picture$'){$script:pipHandle=$handle}};return $true},[IntPtr]::Zero)|Out-Null
if($script:pipHandle -eq [IntPtr]::Zero){throw 'Native PiP window was not found.'}
[PipWindow]::SendMessage($script:pipHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null`;
const results=[];
try {
  assert.equal(await page(`(()=>{const video=document.querySelector('.native-player.player-focused video');window.pipRegressionVideo=video;return !!video&&video.readyState>=3&&!video.paused;})()`),true,'Start with a playing video in the focused slot.');
  for(const paused of [false,true,false]) {
    await page(`document.querySelector('button[aria-label="Picture in picture"]').click()`);
    await until(`document.pictureInPictureElement===window.pipRegressionVideo`);
    if(paused){await page('document.pictureInPictureElement.pause()');await until(`!!document.querySelector('button[aria-label="Play stream"]')`);}
    await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',closePip],{windowsHide:true});
    await until('!document.pictureInPictureElement');
    const before=await page('window.pipRegressionVideo.currentTime');
    await new Promise(resolve=>setTimeout(resolve,600));
    const after=await page(`({connected:window.pipRegressionVideo.isConnected,paused:window.pipRegressionVideo.paused,time:window.pipRegressionVideo.currentTime})`);
    results.push({case:paused?'paused native close':'playing native close',before,after});
    assert.equal(after.connected,true,'The same player must survive closing PiP.');
    assert.equal(after.paused,paused,JSON.stringify(results));
    if(paused)assert.equal(after.time,before,'Closing paused PiP must not restart it.');
    else assert.ok(after.time>before+0.2,'Closing playing PiP must keep media advancing.');
    if(paused){await page(`document.querySelector('button[aria-label="Play stream"]').click()`);await until('!window.pipRegressionVideo.paused');}
  }
  await writeFile(path.join(import.meta.dirname,'../.desktop-runtime/pip-regression-result.json'),JSON.stringify({results},null,2)+'\n');
  console.log(JSON.stringify({passed:true,results}));
} finally {
  await page(`(async()=>{if(document.pictureInPictureElement)await document.exitPictureInPicture();const play=document.querySelector('button[aria-label="Play stream"]');if(play)play.click();else await window.pipRegressionVideo?.play();delete window.pipRegressionVideo;})()`).catch(()=>{});
  socket.close();
}
