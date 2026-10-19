const {randomUUID}=require('node:crypto');
const {session,WebContentsView,ipcMain}=require('electron');
const {playerDocument}=require('./player-document.cjs');
const {selectedPlayerEvidence}=require('./player-evidence.cjs');
const {nativePlayerControls}=require('./player-controls.cjs');
const {createPlayerChrome}=require('./player-chrome.cjs');
const {registerTrustedUi}=require('./security.cjs');
const {publicUrl,publicNetworkUrl,sourceRequestAllowed,createNetworkBudget,createPinnedProxy,pinnedAddress}=require('./source-network.cjs');
const verificationPolicy=require('../lib/playback/verification-policy.json');
const VERIFICATION_NO_PROGRESS_MS=12_000;
const VIEWING_NO_PROGRESS_MS=15_000;

function createIsolatedPlayers({authorizeTarget,createSession=()=>session.fromPartition(`isolated-player-${randomUUID()}`,{cache:false}),
  createView=webPreferences=>new WebContentsView({webPreferences}),createProxy=createPinnedProxy,pinAddress=pinnedAddress}){
  const offers=new Map(),hosts=new Map(),partitions=[];
  let stopped=false;
  const invalid=()=>new Error('Player capability expired or unavailable');
  const chrome=createPlayerChrome({createView,ipcMain,
    isCurrent:(offer,host)=>offers.get(offer.capability)===offer&&offer.host===host&&host.purpose==='viewing'&&
      host.focusedOffer===offer&&offer.runtime?.visible===true&&offer.layout?.focused===true&&!!offer.layout.controls,
    act:async(host,offer,action,current)=>{
      if(!current())throw invalid();
      if(action.kind==='set-quality'||action.kind==='set-picture-in-picture'){
        if(action.kind==='set-quality')publish(offer,{kind:'action',action});
        return control({sender:host.contents,senderFrame:host.contents.mainFrame},
          {capability:offer.capability,command:action},current);
      }
      if(action.kind==='set-fullscreen'||action.kind==='shortcut'){
        await host.contents.executeJavaScript(`window.dispatchEvent(new CustomEvent('sunday-player-controls-action',{detail:${JSON.stringify({capability:offer.capability,action})}}))`,true);
        if(!current())throw invalid();
      }else publish(offer,{kind:'action',action});
      return {kind:'applied'};
    }});
  function leaseSession(){
    let partition=partitions.find(item=>item.state==='free');
    if(!partition){
      if(partitions.length>=verificationPolicy.concurrency+4){const error=new Error('Player capacity unavailable');error.name='PlayerCapacityError';throw error;}
      partition={session:createSession(),state:'free'};partitions.push(partition);
    }
    partition.state='leased';return partition;
  }
  async function cleanSession(partition){
    partition.state='cleaning';
    let timer;
    try{
      await Promise.race([(async()=>{
        await partition.session.closeAllConnections();
        await partition.session.clearAuthCache();
        await partition.session.clearStorageData();
        await partition.session.clearCache();
        if(Object.keys(partition.session.serviceWorkers.getAllRunning()).length)throw new Error('Player workers are still active');
      })(),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Player cleanup timed out')),5000);timer.unref?.();})]);
      partition.state='free';
    }catch{partition.state='quarantined';}
    finally{clearTimeout(timer);}
  }
  function sender(event){
    const host=hosts.get(event.sender);
    if(!host||host.window.isDestroyed()||event.senderFrame!==event.sender.mainFrame)throw invalid();
    try{if(new URL(event.senderFrame.url).origin!==host.origin)throw invalid();}catch{throw invalid();}
    return host;
  }
  function owned(event,input){
    const host=sender(event),offer=offers.get(input?.capability);
    if(!offer||offer.host&&offer.host!==host||offer.target.purpose==='verification'&&host.purpose!=='verification'||
      offer.target.purpose!=='verification'&&host.purpose!=='viewing')throw invalid();
    return {host,offer};
  }
  function publish(offer,value){
    if(offer.host&&!offer.host.closed&&!offer.host.window.isDestroyed()&&!offer.host.contents.isDestroyed())
      offer.host.contents.send('sunday-player:state',{capability:offer.capability,...value});
  }
  function armNoProgressTimeout(offer,runtime){
    clearTimeout(runtime.noProgressTimer);
    if(offer.target.purpose!=='verification'||offer.runtime!==runtime||runtime.proved)return;
    const progressAt=runtime.lastProgressAt??runtime.startedAt;
    runtime.noProgressTimer=setTimeout(()=>{
      runtime.noProgressTimer=null;
      if(offer.runtime!==runtime||runtime.proved)return;
      const remaining=(runtime.lastProgressAt??runtime.startedAt)+VERIFICATION_NO_PROGRESS_MS-Date.now();
      if(remaining>0){armNoProgressTimeout(offer,runtime);return;}
      publish(offer,{kind:'failed',reason:'upstream'});revoke(offer.capability);
    },Math.max(0,progressAt+VERIFICATION_NO_PROGRESS_MS-Date.now()));
  }
  function dispose(offer){
    offer.mountVersion++;
    if(offer.host){chrome.hide(offer.host,offer);if(offer.host.focusedOffer===offer)offer.host.focusedOffer=null;}
    const runtime=offer.runtime;
    offer.runtime=null;
    if(!runtime)return Promise.resolve();
    clearInterval(runtime.poll);clearTimeout(runtime.noProgressTimer);runtime.network?.close();runtime.proxy?.stop();
    try{if(runtime.view)offer.host?.window.contentView.removeChildView(runtime.view);}catch{}
    if(runtime.contents&&!runtime.contents.isDestroyed())runtime.contents.close();
    runtime.session.webRequest.onBeforeRequest((_details,callback)=>callback({cancel:true}));
    runtime.session.removeListener('will-download',runtime.preventDownload);
    return cleanSession(runtime.partition);
  }
  function revoke(capability){
    const offer=offers.get(capability);if(!offer)return;
    offers.delete(capability);clearTimeout(offer.timer);const cleanup=dispose(offer);publish(offer,{kind:'ended'});return cleanup;
  }
  function registerHost(window,origin,purpose){
    if(stopped||!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)||!['viewing','verification'].includes(purpose))throw invalid();
    const contents=window.webContents,host={window,contents,origin,purpose,closed:false};
    hosts.get(contents)?.unregisterUi?.();hosts.set(contents,host);
    if(purpose==='viewing')host.unregisterUi=registerTrustedUi(contents,origin);
    const close=()=>{host.closed=true;host.unregisterUi?.();hosts.delete(contents);chrome.destroy(host);for(const offer of offers.values())if(offer.host===host)revoke(offer.capability);};
    window.once('closed',close);contents.once('destroyed',close);
    contents.on('did-start-navigation',(_event,_url,_inPlace,main)=>{if(main)for(const offer of offers.values())if(offer.host===host)revoke(offer.capability);});
  }
  async function offer({target,player,deadline}){
    if(stopped||offers.size>=128||!target||typeof target.sessionId!=='string'||typeof target.candidateId!=='string'||
      typeof target.gameId!=='string'||!Number.isSafeInteger(target.generation)||target.generation<0||
      !playerDocument(player?.url)||!publicUrl(player?.referer)||
      deadline!==undefined&&(!Number.isSafeInteger(deadline)||deadline<=Date.now())||!await authorizeTarget(target))throw invalid();
    if(stopped)throw invalid();
    const capability=randomUUID(),entry={capability,target:{...target},player:{...player},runtime:null,host:null,mountVersion:0};
    if(deadline!==undefined)entry.timer=setTimeout(()=>revoke(capability),Math.max(0,deadline-Date.now()-1000));
    offers.set(capability,entry);return capability;
  }
  function layout(offer){
    const runtime=offer.runtime;if(!runtime?.view)return;
    const {width,height}=offer.host.window.getContentBounds(),input=offer.layout||{};
    const bounds=input.bounds||{x:0,y:0,width:0,height:0};
    const x=Math.min(width,Math.max(0,bounds.x)),y=Math.min(height,Math.max(0,bounds.y));
    const right=Math.min(width,Math.max(x,bounds.x+bounds.width)),bottom=Math.min(height,Math.max(y,bounds.y+bounds.height));
    const clipped={x:Math.round(x),y:Math.round(y),width:Math.max(0,Math.round(right-x)),height:Math.max(0,Math.round(bottom-y))};
    runtime.view.setBounds(clipped);
    const visible=input.visible===true&&right>x&&bottom>y;
    runtime.visible=visible;
    runtime.view.setVisible(visible);
    runtime.contents.setAudioMuted(!visible||input.audible!==true||offer.host.purpose==='verification');
    if(offer.host.purpose==='viewing'&&visible&&input.focused===true&&input.controls&&offer.host.focusedOffer===offer){
      chrome.bind(offer.host,offer,clipped,{label:input.controls.label,playing:input.playing===true,audible:input.audible===true,
        volume:Math.round((input.volume??0)*100),fullscreen:input.controls.fullscreen,presentation:runtime.playerPresentation??null});
    }else chrome.hide(offer.host,offer);
  }
  function publishPresentation(offer,runtime,presentation){
    if(!presentation)return;
    if(presentation.pip.kind==='available'&&presentation.pip.active||
      runtime.playerPresentation?.pip.kind==='available'&&runtime.playerPresentation.pip.active){
      if(presentation.playing!==offer.layout?.playing)runtime.pipPlaying=presentation.playing;
      else delete runtime.pipPlaying;
    }
    const signature=JSON.stringify(presentation);
    if(signature===runtime.presentation)return;
    runtime.presentation=signature;runtime.playerPresentation=presentation;publish(offer,{kind:'presentation',presentation});layout(offer);
  }
  async function selected(offer,runtime,controls){
      if(offer.runtime!==runtime||runtime.contents.isDestroyed())return null;
      const main=runtime.contents.mainFrame;
      let frame=main;
      if(main.url!==offer.player.url)return null;
      const edges=[];
      let value;
      for(let depth=0;depth<8;depth++){
        const url=frame.url;
        value=await frame.executeJavaScript(`(${selectedPlayerEvidence.toString()})(document,getComputedStyle,${JSON.stringify(controls)},${nativePlayerControls.toString()})`);
        if(offer.runtime!==runtime||frame.isDestroyed()||frame.url!==url)return null;
        if(value?.kind!=='frame')break;
        const children=main.framesInSubtree.filter(child=>!child.isDestroyed()&&child.parent===frame&&child.url===value.url);
        if(children.length!==1){value=null;break;}
        edges.push({parent:frame,child:children[0],url:children[0].url,parentUrl:url});frame=children[0];
      }
      const current=()=>offer.runtime===runtime&&!runtime.contents.isDestroyed()&&main.url===offer.player.url&&!frame.isDestroyed()&&
        edges.every(edge=>!edge.parent.isDestroyed()&&!edge.child.isDestroyed()&&edge.child.parent===edge.parent&&
          edge.parent.url===edge.parentUrl&&edge.child.url===edge.url);
      return current()?{frame,value,current}:null;
  }
  async function sample(offer){
    const runtime=offer.runtime;if(!runtime?.view||runtime.sampling)return;
    runtime.sampling=true;
    try{
      if(Date.now()-runtime.authorizedAt>=5000){
        runtime.authorizedAt=Date.now();
        if(!await authorizeTarget(offer.target)){revoke(offer.capability);return;}
      }
      const playing=offer.pendingPlaying;
      const result=await selected(offer,runtime,{...(typeof playing==='boolean'?{playing}:{}),
        resume:typeof playing!=='boolean'&&offer.layout?.playing===true&&runtime.pipPlaying===undefined&&
          !(runtime.playerPresentation?.pip.kind==='available'&&runtime.playerPresentation.pip.active),
        audible:offer.host.purpose==='viewing'&&offer.layout?.audible===true,volume:offer.layout?.volume??0,isolate:true});
      if(!result)return;
      const {value}=result;
      if(value?.kind==='video'&&offer.pendingPlaying===playing)delete offer.pendingPlaying;
      publishPresentation(offer,runtime,value?.presentation);
      const now=Date.now();
      if(runtime.proved&&offer.host.purpose==='viewing'){
        const previous=runtime.viewerProgress;
        if(value?.kind!=='video'||value.ended||value.seeking||!Number.isFinite(value.time)||!Number.isFinite(value.frames)||
          !runtime.visible||offer.layout?.playing!==true||runtime.pipPlaying!==undefined||
          runtime.playerPresentation?.pip.kind==='available'&&runtime.playerPresentation.pip.active||
          value.frames<0)runtime.viewerProgress=undefined;
        else{
          const progressAt=!previous||now<previous.at||now-previous.at>6000||value.time>previous.time&&value.frames>previous.frames?now:previous.progressAt;
          runtime.viewerProgress={at:now,time:value.time,frames:value.frames,progressAt};
          if(now-progressAt>=VIEWING_NO_PROGRESS_MS){publish(offer,{kind:'failed',reason:'upstream'});revoke(offer.capability);return;}
        }
      }
      if(value?.kind!=='video'||!value.playing||value.width<=0||value.height<=0||!Number.isFinite(value.time)||!Number.isFinite(value.frames)||value.frames<1){runtime.first=null;runtime.previous=null;return;}
      const previous=runtime.previous;
      const implausible=previous&&(now-previous.at>6000||value.time<=previous.time||value.frames<=previous.frames||
        (value.time-previous.time)*1000>(now-previous.at)*1.5+500);
      if(implausible)runtime.first=null;
      const current={...value,at:now};runtime.first??=current;runtime.previous=current;
      if(previous&&!implausible){runtime.lastProgressAt=now;armNoProgressTimeout(offer,runtime);}
      const observed=now-runtime.first.at,advance=(value.time-runtime.first.time)*1000,frames=value.frames-runtime.first.frames+1;
      if(observed>=2000&&advance>=2000&&frames>=3&&now>=runtime.nextProof){
        runtime.proved=true;clearTimeout(runtime.noProgressTimer);runtime.noProgressTimer=null;runtime.nextProof=now+60_000;
        if(offer.host.purpose==='viewing')runtime.viewerProgress={at:now,time:value.time,frames:value.frames,progressAt:now};
        publish(offer,{kind:'decoded',proof:{kind:'advancing-video',version:1,startupMs:now-runtime.startedAt,
          observedMs:Math.round(observed),mediaAdvanceMs:Math.round(advance),presentedFrames:frames}});
        runtime.first=null;
      }
    }catch{}finally{runtime.sampling=false;}
  }
  async function mount(event,input){
    const {host,offer}=owned(event,input);
    const version=offer.mountVersion;
    if(!await authorizeTarget(offer.target)||offers.get(offer.capability)!==offer||offer.mountVersion!==version)throw invalid();
    if(sender(event)!==host)throw invalid();
    offer.host=host;
    if(offer.runtime)return;
    let ownedRuntime;
    try{
    const partition=leaseSession(),sourceSession=partition.session;
    ownedRuntime={session:sourceSession,partition};
    offer.runtime=ownedRuntime;
    sourceSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    sourceSession.setPermissionCheckHandler(()=>false);
    ownedRuntime.preventDownload=(event,item)=>{event.preventDefault();item?.cancel();};
    sourceSession.on('will-download',ownedRuntime.preventDownload);
    const network=createNetworkBudget({mode:'playback',onLimit:()=>{publish(offer,{kind:'failed',reason:'upstream'});revoke(offer.capability);}});
    const proxy=createProxy({session:sourceSession,getBudget:()=>offer.runtime?.network,pinAddress});
    Object.assign(offer.runtime,{network,proxy});
    sourceSession.webRequest.onBeforeRequest((details,callback)=>{
      if(offer.runtime?.session!==sourceSession||!sourceRequestAllowed(details,offer.player.url)||
        details.resourceType==='mainFrame'&&details.url!==offer.player.url&&details.url!==publicNetworkUrl(offer.player.url)?.href||
        ['image','font','ping','cspReport'].includes(details.resourceType)||!network.request()){
        callback({cancel:true});return;
      }
      if(details.resourceType!=='subFrame'){callback({cancel:false});return;}
      const selected=async()=>{
        const runtime=offer.runtime,child=details.frame,parent=child?.parent,parentUrl=parent?.url;
        if(!runtime?.view||!parent||parent.isDestroyed())return false;
        const evidence=await parent.executeJavaScript(`(${selectedPlayerEvidence.toString()})()`);
        return offer.runtime===runtime&&!parent.isDestroyed()&&parent.url===parentUrl&&child.parent===parent&&
          evidence?.kind==='frame'&&(evidence.url===details.url||publicNetworkUrl(evidence.url)?.href===details.url);
      };
      void selected().then(allowed=>callback({cancel:!allowed}),()=>callback({cancel:true}));
    });
    const view=createView({session:sourceSession,sandbox:true,contextIsolation:true,nodeIntegration:false,
      webSecurity:true,disableDialogs:true,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'});
    const contents=view.webContents;
    const runtime=ownedRuntime;
    Object.assign(runtime,{view,contents,network,proxy,startedAt:Date.now(),authorizedAt:Date.now(),nextProof:0});
    armNoProgressTimeout(offer,runtime);
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');contents.setAudioMuted(true);
    contents.setWindowOpenHandler(()=>({action:'deny'}));
    for(const name of ['will-navigate','will-redirect','will-frame-navigate'])contents.on(name,(event,url)=>{
      if(event.isMainFrame!==false&&(event.url||url)!==offer.player.url)event.preventDefault();
    });
    contents.on('frame-created',()=>{try{network.frames(contents.mainFrame.framesInSubtree.length);}catch{}});
    contents.on('will-attach-webview',event=>event.preventDefault());
    contents.on('login',(event,_details,authInfo,callback)=>{
      if(!authInfo.isProxy||authInfo.host!=='127.0.0.1')return;
      event.preventDefault();callback(proxy.credentials.username,proxy.credentials.password);
    });
    contents.on('render-process-gone',()=>{publish(offer,{kind:'failed',reason:'playback'});revoke(offer.capability);});
    contents.on('focus',()=>{
      if(offer.runtime!==runtime||offer.host!==host||!runtime.visible||host.purpose!=='viewing')return;
      if(host.focusedOffer===offer&&offer.layout?.controls)chrome.focus(host);
      else publish(offer,{kind:'action',action:{kind:'focus-player'}});
    });
    host.window.contentView.addChildView(view);view.setVisible(false);view.setBounds({x:0,y:0,width:320,height:180});
    chrome.raise(host);
      await proxy.start();
      if(offer.runtime!==runtime||offers.get(offer.capability)!==offer)throw invalid();
      layout(offer);
      await contents.loadURL(offer.player.url,{httpReferrer:offer.player.referer});
      if(offer.runtime!==runtime)throw invalid();
      layout(offer);
      offer.runtime.poll=setInterval(()=>void sample(offer),500);
    }catch(error){if(offer.runtime===ownedRuntime)void dispose(offer);throw error;}
  }
  async function update(event,input){
    const {host,offer}=owned(event,input);
    const {bounds,visible,playing,audible,volume,focused,controls}=input;
    if(bounds!==undefined&&(!bounds||!['x','y','width','height'].every(key=>Number.isFinite(bounds[key])&&Math.abs(bounds[key])<=100000)||bounds.width<0||bounds.height<0)||
      [visible,playing,audible,focused].some(value=>value!==undefined&&typeof value!=='boolean')||
      volume!==undefined&&(!Number.isFinite(volume)||volume<0||volume>1)||
      controls!==undefined&&controls!==null&&(typeof controls.label!=='string'||controls.label.length>160||typeof controls.fullscreen!=='boolean'||
        Object.keys(controls).some(key=>!['label','fullscreen'].includes(key))))throw invalid();
    if(typeof playing==='boolean'&&playing!==offer.layout?.playing)offer.pendingPlaying=playing;
    if(offer.runtime&&typeof playing==='boolean'&&playing===offer.runtime.pipPlaying)delete offer.runtime.pipPlaying;
    const transfer=focused===true&&offer.layout?.focused!==true;
    if(focused===true&&host.focusedOffer!==offer){chrome.hide(host);host.focusedOffer=offer;}
    else if(focused===false&&host.focusedOffer===offer)host.focusedOffer=null;
    offer.layout={...offer.layout,...input};layout(offer);
    if(offer.runtime){if(transfer&&visible!==false){if(offer.layout.controls)chrome.focus(offer.host);else offer.runtime.contents.focus();}void sample(offer);}
  }
  async function control(event,input,current=()=>true){
    const {host,offer}=owned(event,input),command=input?.command,runtime=offer.runtime;
    if(!command||typeof command!=='object'||
      command.kind==='set-picture-in-picture'&&(typeof command.active!=='boolean'||Object.keys(command).some(key=>!['kind','active'].includes(key)))||
      command.kind==='set-quality'&&(!command.selection||Object.keys(command).some(key=>!['kind','selection'].includes(key))||
        command.selection.kind!=='auto'&&command.selection.kind!=='level'||
        command.selection.kind==='level'&&(typeof command.selection.id!=='string'||!/^quality-[a-f0-9-]{36}-\d+$/.test(command.selection.id)||command.selection.id.length>128)||
        Object.keys(command.selection).some(key=>!(command.selection.kind==='auto'?['kind']:['kind','id']).includes(key)))||
      !['set-quality','set-picture-in-picture'].includes(command.kind))throw invalid();
    if(!runtime?.view)return {kind:'unavailable',reason:'no-selected-video'};
    if(!await authorizeTarget(offer.target)){revoke(offer.capability);throw invalid();}
    if(sender(event)!==host||offers.get(offer.capability)!==offer||offer.runtime!==runtime||!current())throw invalid();
    try{
      const selection=await selected(offer,runtime,{isolate:true});
      if(!selection||selection.value?.kind!=='video'||!selection.current()||!current())return {kind:'unavailable',reason:'no-selected-video'};
      const value=await selection.frame.executeJavaScript(`(${selectedPlayerEvidence.toString()})(document,getComputedStyle,${JSON.stringify({isolate:true,command})},${nativePlayerControls.toString()})`,command.kind==='set-picture-in-picture');
      if(!selection.current()||!current()||value?.kind!=='control')return {kind:'unavailable',reason:'no-selected-video'};
      publishPresentation(offer,runtime,value.presentation);
      return value.result;
    }catch{return {kind:'unavailable',reason:'unsupported'};}
  }
  function release(event,input){const {offer}=owned(event,input);const cleanup=dispose(offer);offer.host=null;return cleanup;}
  function stop(){stopped=true;chrome.stop();const cleanups=[...offers.keys()].map(revoke);for(const host of hosts.values())host.unregisterUi?.();hosts.clear();return Promise.all(cleanups).then(()=>{});}
  return {registerHost,offer,mount,update,control,release,revoke,stop};
}

module.exports={createIsolatedPlayers};
