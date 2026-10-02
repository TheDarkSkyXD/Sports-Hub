import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { prepareDevelopmentElectron } from './electron-runtime.mjs';

const root=resolve(import.meta.dirname,'..');
const resultPath=resolve(root,'work/sportsurge-catalog-electron/result.json');
rmSync(resultPath,{force:true});
const env={...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.NODE_ENV==='test' && process.env.SUNDAY_ROOM_VERIFIER_EXECUTABLE || await prepareDevelopmentElectron();
const entry=process.env.NODE_ENV==='test' && process.env.SUNDAY_ROOM_VERIFIER_ENTRY || resolve(root,'scripts/verify-sportsurge-catalog.cjs');
const child=spawn(executable,[entry],{
  cwd:root,env,stdio:'inherit',windowsHide:true,
});
const code=await new Promise((resolveExit,reject)=>{
  child.once('error',reject);
  child.once('exit',(status,signal)=>resolveExit(signal ? 1 : status));
});
let result;
try { result=JSON.parse(readFileSync(resultPath,'utf8')); }
catch { result=null; }
let serverGone=false;
if (typeof result?.origin==='string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(result.origin)) {
  const port=Number(new URL(result.origin).port);
  serverGone=await new Promise(resolveClosed=>{
    const socket=connect({host:'127.0.0.1',port});
    socket.once('connect',()=>{socket.destroy();resolveClosed(false);});
    socket.once('error',error=>resolveClosed(error.code==='ECONNREFUSED'));
    socket.setTimeout(1500,()=>{socket.destroy();resolveClosed(false);});
  });
}
if (code!==0 || result?.pass!==true || !serverGone) {
  process.stderr.write(`Sportsurge desktop verification failed: ${result?.error || (!serverGone?'local server remained active':'no passing result')}.\n`);
  process.exitCode=1;
}
