function selectedPlayerEvidence(page=document,computedStyle=getComputedStyle,controls,presentation) {
  const roots=Array.from(page.querySelectorAll('#player, .player, .jwplayer, .video-js'));
  const elements=[...new Set(roots.length?roots.flatMap(root=>[
    ...(root.matches('video, iframe')?[root]:[]),...root.querySelectorAll('video, iframe'),
  ]):page.querySelectorAll('video, iframe'))];
  const clips=value=>['hidden','clip','scroll','auto'].includes(value);
  const visible=elements.filter(element=>{
    if(!element.isConnected||!element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true,contentVisibilityAuto:true}))return false;
    const rect=element.getBoundingClientRect();
    let {left,right,top,bottom}=rect;
    for(let node=element;node;node=node.parentElement){
      const style=computedStyle(node);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
      if(node!==element&&node!==page.documentElement&&(clips(style.overflowX)||clips(style.overflowY))){
        const root=page.documentElement;
        const rootStyle=node===page.body&&root?.tagName==='HTML'?computedStyle(root):null;
        const viewportOverflow=rootStyle?.overflowX==='visible'&&rootStyle.overflowY==='visible'
          &&(!rootStyle.contain||rootStyle.contain==='none')&&(!style.contain||style.contain==='none');
        const clip=viewportOverflow?{left:0,top:0,right:root.clientWidth,bottom:root.clientHeight}:node.getBoundingClientRect();
        if(clips(style.overflowX)){left=Math.max(left,clip.left);right=Math.min(right,clip.right);}
        if(clips(style.overflowY)){top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}
      }
      if(right-left<240||bottom-top<135)return false;
    }
    return true;
  });
  if(visible.length!==1)return null;
  const element=visible[0];
  if(controls?.isolate){
    page.documentElement.inert=true;
    if(element.tagName==='VIDEO')element.controls=false;
    for(let node=element;node?.parentElement;node=node.parentElement){
      for(const sibling of node.parentElement.children)if(sibling!==node&&sibling.tagName!=='SCRIPT'&&sibling.tagName!=='STYLE')
        sibling.style.setProperty('display','none','important');
    }
    for(const [name,value] of Object.entries({position:'fixed',inset:'0',width:'100vw',height:'100vh',margin:'0',zIndex:'2147483647',objectFit:'contain'}))
      element.style.setProperty(name.replace(/[A-Z]/g,letter=>`-${letter.toLowerCase()}`),value,'important');
  }
  if(controls&&element.tagName==='VIDEO'){
    if(controls.command&&presentation)return Promise.resolve(presentation(element,page,window,controls.command)).then(value=>({kind:'control',...value}));
    if(typeof controls.volume==='number')element.volume=controls.volume;
    if(typeof controls.audible==='boolean')element.muted=!controls.audible;
    if((controls.playing===true||controls.resume===true&&!element.ended&&page.pictureInPictureElement!==element)&&element.paused)void element.play().catch(()=>{});
    else if(controls.playing===false&&!element.paused)element.pause();
    const quality=element.getVideoPlaybackQuality?.();
    return {kind:'video',time:element.currentTime,frames:quality?quality.totalVideoFrames-quality.droppedVideoFrames:0,
      width:element.videoWidth,height:element.videoHeight,playing:!element.paused&&!element.seeking&&element.readyState>=2,
      ended:element.ended,seeking:element.seeking,
      ...(presentation?{presentation:presentation(element,page,window)}:{})};
  }
  const address=value=>{
    try{const url=new URL(value,page.baseURI);return url.protocol==='https:'?url.href:null;}catch{return null;}
  };
  if(element.tagName==='IFRAME')return {kind:'frame',url:address(element.src)};
  const sources=new Set();
  const add=value=>{if(typeof value==='string'){const url=address(value);if(url)sources.add(url);}};
  add(element.currentSrc||element.src);
  let jwSource=null,loaderConfigured=false;
  if(typeof window.jwplayer==='function'){
    try{
      const player=window.jwplayer(),container=player?.getContainer?.();
      const config=player?.getConfig?.(),item=player?.getPlaylistItem?.();
      if(container?.contains(element)){
        add(item?.file);
        if(typeof config?.file==='string'&&config.file===item?.file){
          jwSource=address(config.file);
          loaderConfigured=typeof LiveLoader==='function'&&config?.hlsjsConfig?.loader===LiveLoader;
        }
      }
    }catch{}
  }
  if(window.hls?.media===element)add(window.hls.url);
  const adaptive=window.player;
  try{if(adaptive?.getMediaElement?.()===element)add(adaptive.getAssetUri?.());}catch{}
  const clappr=window.player?.core?.activePlayback;
  if(clappr?.el===element||clappr?.el?.contains(element))add(window.player.options?.source);
  if(typeof window.videojs?.getPlayers==='function'){
    for(const player of Object.values(window.videojs.getPlayers()).slice(0,16)){
      try{if(player?.el?.()?.contains(element))add(player.currentSource?.()?.src);}catch{}
    }
  }
  return {kind:'media',sources:[...sources],jwSource,loaderConfigured};
}

module.exports={selectedPlayerEvidence};
