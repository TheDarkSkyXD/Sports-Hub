import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import test from 'node:test';
import {observedPublicPage} from '../lib/playback/providers/public-page.ts';

const file=new URL('../desktop/isolated-player.cjs',import.meta.url);
const localRequire=createRequire(file);
const {playerDocument}=localRequire('./player-document.cjs') as {playerDocument:(value:string)=>URL|null};
const ingest='https://embed.st/embed/ingest/streamedphiladelphiaeagles/1/#player=clappr&autoplay=true';
const referer='https://rockyembed.st/source/streamed.php?hd=276&id=2260&no=1';

test('only the exact published LiveSportPro ingest document is a native player',()=>{
  assert.equal(playerDocument(ingest)?.href,ingest);
  assert.equal(playerDocument('https://embed.st/embed/golf/2260/2')?.href,'https://embed.st/embed/golf/2260/2');
  for(const value of [
    'https://embed.st/embed/ingest/streamedphiladelphiaeagles/1/#player=clappr',
    'https://embed.st/embed/ingest/streamedphiladelphiaeagles/1/#player=clappr&autoplay=false',
    'https://embed.st/embed/ingest/streamedphiladelphiaeagles/1/?player=clappr#player=clappr&autoplay=true',
    'https://rockyembed.st/embed/ingest/streamedphiladelphiaeagles/1/#player=clappr&autoplay=true',
    'https://embed.st/embed/ingest/streamedphiladelphiaeagles/0/#player=clappr&autoplay=true',
    'https://embed.st/embed/ingest/streamedphiladelphiaeagles/001/#player=clappr&autoplay=true',
    'https://embed.st/embed/ingest/streamedphiladelphiaeagles/1000/#player=clappr&autoplay=true',
    'https://embed.st/embed/golf/2260/2/#player=clappr&autoplay=true',
    'https://embed.st/embed/golf/2260/2#player=clappr&autoplay=true',
  ])assert.equal(playerDocument(value),null,value);
});

test('observer returns only the exact owned LiveSportPro leaf and its proven parent',async()=>{
  const replies=[
    {kind:'incomplete',phase:'capture',reason:'deadline',retryAfterMs:30000,player:{url:ingest,referer}},
    {kind:'incomplete',phase:'capture',reason:'deadline',retryAfterMs:30000,
      player:{url:'https://embed.st/embed/golf/2260/2/#player=clappr&autoplay=true',referer}},
  ];
  const server=createServer((_request,response)=>{
    const reply=replies.shift();
    assert.ok(reply);
    response.writeHead(503,{'content-type':'application/json'});
    response.end(JSON.stringify(reply));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const previousOrigin=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const previousToken=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='fixture-token';
  try{
    const playback=await observedPublicPage(new URL('https://embed.st/embed/golf/2260/2'),new AbortController().signal,'probe');
    assert.deepEqual(playback?.player,{url:ingest,referer});
    assert.equal(playback?.root,null);
    playback?.close();
    await assert.rejects(
      observedPublicPage(new URL('https://embed.st/embed/golf/2260/2'),new AbortController().signal,'probe'),
      {name:'ProviderDeferredError',reason:'unverified'},
    );
    assert.equal(replies.length,0);
  }finally{
    if(previousOrigin===undefined)delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
    else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=previousOrigin;
    if(previousToken===undefined)delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
    else process.env.SUNDAY_ROOM_CONTROL_TOKEN=previousToken;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('native player admits the exact ingest main-frame transport without its document fragment',async()=>{
  let request:((details:object,callback:(result:object)=>void)=>void)|null=null;
  const main={url:ingest,framesInSubtree:[],isDestroyed:()=>false,executeJavaScript:async()=>null};
  class Session extends EventEmitter{
    serviceWorkers={getAllRunning:()=>({})};
    webRequest={onBeforeRequest:(hook:typeof request)=>{request=hook;}};
    setPermissionRequestHandler(){}setPermissionCheckHandler(){}
    async closeAllConnections(){}async clearAuthCache(){}async clearStorageData(){}async clearCache(){}
  }
  class View{
    webContents=Object.assign(new EventEmitter(),{mainFrame:main,isDestroyed:()=>false,setWebRTCIPHandlingPolicy(){},setAudioMuted(){},
      setWindowOpenHandler(){},loadURL:async()=>{},close(){},focus(){}});
    setBounds(){}setVisible(){}
  }
  const contents=Object.assign(new EventEmitter(),{mainFrame:{url:'http://127.0.0.1:9000/'},isDestroyed:()=>false,send(){}});
  const host=Object.assign(new EventEmitter(),{webContents:contents,isDestroyed:()=>false,getContentBounds:()=>({width:640,height:360}),
    contentView:{addChildView(){},removeChildView(){}}});
  const loaded=runInThisContext(`(function(require,module,setInterval,clearInterval){${readFileSync(file,'utf8')};return module.exports;})`)(
    (id:string)=>id==='electron'?{}:localRequire(id),{exports:{}},()=>1,()=>{});
  const factory=loaded.createIsolatedPlayers({authorizeTarget:async()=>true,createSession:()=>new Session(),
    createView:()=>new View(),createProxy:()=>({credentials:{username:'fixture',password:'fixture'},start:async()=>{},stop(){}})});
  factory.registerHost(host,'http://127.0.0.1:9000','viewing');
  const event={sender:contents,senderFrame:contents.mainFrame};
  try{
    const capability=await factory.offer({target:{sessionId:'b2ad7c25-e8fb-4c46-b809-dbc1b5ec5eb7',candidateId:'leaf',gameId:'fixture',generation:0},
      player:{url:ingest,referer}});
    await factory.mount(event,{capability});
    assert.ok(request);
    const results:object[]=[];
    request({url:'https://embed.st/embed/ingest/streamedphiladelphiaeagles/1/',resourceType:'mainFrame'},value=>results.push(value));
    request({url:ingest,resourceType:'mainFrame'},value=>results.push(value));
    request({url:'https://embed.st/embed/ingest/streamedphiladelphiaeagles/1/#player=jwplayer',resourceType:'mainFrame'},
      value=>results.push(value));
    assert.deepEqual(results,[{cancel:false},{cancel:false},{cancel:true}]);
  }finally{await factory.stop();}
});

test('an owned LiveSportPro player iframe keeps its fragment identity across the network boundary',async()=>{
  let request:((details:object,callback:(result:object)=>void)=>void)|null=null;
  const selectedUrl='https://embed.st/embed/ingest/streamedphiladelphiaeagles/1/#player=clappr&autoplay=true';
  const networkUrl='https://embed.st/embed/ingest/streamedphiladelphiaeagles/1/';
  const parent={url:'https://rockyembed.st/source/streamed.php?hd=276&id=2260&no=1',isDestroyed:()=>false,
    executeJavaScript:async()=>({kind:'frame',url:selectedUrl})};
  const child={url:selectedUrl,parent,isDestroyed:()=>false};
  const main={url:'https://embed.st/embed/golf/2260/2',framesInSubtree:[parent,child],isDestroyed:()=>false,
    executeJavaScript:async()=>({kind:'frame',url:parent.url})};
  class Session extends EventEmitter{
    serviceWorkers={getAllRunning:()=>({})};
    webRequest={onBeforeRequest:(hook:typeof request)=>{request=hook;}};
    setPermissionRequestHandler(){}setPermissionCheckHandler(){}
    async closeAllConnections(){}async clearAuthCache(){}async clearStorageData(){}async clearCache(){}
  }
  class View{
    webContents=Object.assign(new EventEmitter(),{mainFrame:main,isDestroyed:()=>false,setWebRTCIPHandlingPolicy(){},setAudioMuted(){},
      setWindowOpenHandler(){},loadURL:async()=>{},close(){},focus(){}});
    setBounds(){}setVisible(){}
  }
  const contents=Object.assign(new EventEmitter(),{mainFrame:{url:'http://127.0.0.1:9000/'},isDestroyed:()=>false,send(){}});
  const host=Object.assign(new EventEmitter(),{webContents:contents,isDestroyed:()=>false,getContentBounds:()=>({width:640,height:360}),
    contentView:{addChildView(){},removeChildView(){}}});
  const loaded=runInThisContext(`(function(require,module,setInterval,clearInterval){${readFileSync(file,'utf8')};return module.exports;})`)(
    (id:string)=>id==='electron'?{}:localRequire(id),{exports:{}},()=>1,()=>{});
  const sourceSession=new Session();
  const factory=loaded.createIsolatedPlayers({authorizeTarget:async()=>true,createSession:()=>sourceSession,
    createView:()=>new View(),createProxy:()=>({credentials:{username:'fixture',password:'fixture'},start:async()=>{},stop(){}})});
  factory.registerHost(host,'http://127.0.0.1:9000','viewing');
  const event={sender:contents,senderFrame:contents.mainFrame};
  try{
    const capability=await factory.offer({target:{sessionId:'d03a2653-5d97-4453-8e6b-681861777337',candidateId:'selected',gameId:'fixture',generation:0},
      player:{url:main.url,referer:'https://livesportpro.com/'}});
    await factory.mount(event,{capability});
    assert.ok(request);
    const selected:object[]=[];
    request({url:networkUrl,resourceType:'subFrame',frame:child},value=>selected.push(value));
    request({url:selectedUrl,resourceType:'subFrame',frame:child},value=>selected.push(value));
    request({url:'https://embed.st/embed/ingest/streamedphiladelphiaeagles/1/#player=jwplayer',resourceType:'subFrame',frame:child},
      value=>selected.push(value));
    const unrelated:object[]=[];
    request({url:'https://embed.st/embed/ingest/unrelated/1/',resourceType:'subFrame',frame:child},value=>unrelated.push(value));
    for(let turn=0;turn<12;turn++)await Promise.resolve();
    assert.deepEqual(selected,[{cancel:false},{cancel:false},{cancel:true}]);
    assert.deepEqual(unrelated,[{cancel:true}]);
  }finally{await factory.stop();}
});
