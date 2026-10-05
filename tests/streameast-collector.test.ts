import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import test from 'node:test';

const require=createRequire(import.meta.url);

test('one HTTP 429 delays manual and interval sweeps even when the checkpoint fails',async()=>{
  const Module=require('node:module');
  const original=Module._load;
  let reads=0;
  let sweeps=0;
  const sourceSession={setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){}};
  function BrowserWindow(){
    const contents=new EventEmitter();
    let url='';
    let destroyed=false;
    Object.assign(contents,{setAudioMuted(){},setWindowOpenHandler(){},getURL(){return url;},stop(){},
      mainFrame:{executeJavaScript(){throw new Error('The rate-limited page must not be parsed');}}});
    return {webContents:contents,isDestroyed(){return destroyed;},destroy(){destroyed=true;},loadURL(target:string){
      url=target;
      contents.emit('did-frame-navigate',null,target,429,null,true);
      contents.emit('dom-ready');
      return Promise.resolve();
    }};
  }
  Module._load=function(request:string,parent:{filename?:string}|null,isMain:boolean){
    if(parent?.filename?.endsWith('streameast-collector.cjs')){
      if(request==='electron')return {BrowserWindow,session:{fromPartition(){return sourceSession;}}};
      if(request==='./streameast-sweep.cjs')return {runStreameastSweep:async({read,signal}:{
        read:(url:string,page:string,league:string,signal:AbortSignal)=>Promise<string>;signal:AbortSignal;
      })=>{
        sweeps++;
        try {reads++;await read('https://v2.streameast.ga/cfb-streams/','category','ncaaf',signal);}
        catch(error){assert.equal(error instanceof Error?error.message:String(error),'rate-limited');}
        throw new Error('checkpoint failed');
      }};
    }
    return original.call(this,request,parent,isMain);
  };
  let createStreameastCollector;
  try {({createStreameastCollector}=require('../desktop/streameast-collector.cjs'));}
  finally {Module._load=original;}
  const collector=createStreameastCollector({origin:'http://127.0.0.1:1',controlToken:'unused'});
  try {
    await collector.requestSweep();
    await collector.requestSweep();
    collector.start();
    assert.equal(sweeps,1);
    assert.equal(reads,1);
  } finally {collector.stop();}
});
