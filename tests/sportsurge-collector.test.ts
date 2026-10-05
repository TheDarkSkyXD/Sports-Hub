import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';

const require=createRequire(import.meta.url);

test('a 403 challenge stays blocked and a 429 cools down even if the checkpoint fails',async()=>{
  const Module=require('node:module');
  const original=Module._load;
  let failure='';
  let status=403;
  let title='Just a moment...';
  let sweeps=0;
  const sourceSession={
    setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){},
  };
  function BrowserWindow(){
    const contents=new EventEmitter();
    let url='';
    Object.assign(contents,{
      setAudioMuted(){},setWindowOpenHandler(){},getURL(){return url;},getTitle(){return title;},
      stop(){},executeJavaScript(){return new Promise(()=>{});},
    });
    let destroyed=false;
    return {webContents:contents,isDestroyed(){return destroyed;},destroy(){destroyed=true;},loadURL(target:string){
      url=target;
      contents.emit('did-frame-navigate',null,target,status,null,true);
      contents.emit('dom-ready');
      return Promise.resolve();
    }};
  }
  Module._load=function(request:string,parent:{filename?:string}|null,isMain:boolean){
    if(parent?.filename?.endsWith('sportsurge-collector.cjs')){
      if(request==='electron')return {BrowserWindow,session:{fromPartition(){return sourceSession;}}};
      if(request==='./sportsurge-sweep.cjs')return {runSportsurgeSweep:async({read,signal}:{
        read:(url:string,page:string,league:string,signal:AbortSignal)=>Promise<string>;signal:AbortSignal;
      })=>{
        sweeps++;
        try {await read('https://v2.sportsurge.net/watch-cfb-streams/','category','ncaaf',signal);}
        catch(error){failure=error instanceof Error?error.message:String(error);}
        if(status===429)throw new Error('checkpoint failed');
        return {state:{kind:'partial',reason:failure}};
      }};
    }
    return original.call(this,request,parent,isMain);
  };
  let createSportsurgeCollector;
  try {({createSportsurgeCollector}=require('../desktop/sportsurge-collector.cjs'));}
  finally {Module._load=original;}
  const collector=createSportsurgeCollector({origin:'http://127.0.0.1:1',controlToken:'unused',readyTimeoutMs:20});
  try {await collector.requestSweep();}
  finally {collector.stop();}
  assert.equal(failure,'blocked');
  status=429;
  title='Rate limited';
  const limited=createSportsurgeCollector({origin:'http://127.0.0.1:1',controlToken:'unused',readyTimeoutMs:20});
  try {
    await limited.requestSweep();
    assert.equal(failure,'rate-limited');
    await limited.requestSweep();
    limited.start();
    assert.equal(sweeps,2);
  } finally {limited.stop();}
});
