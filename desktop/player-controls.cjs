function nativePlayerControls(video,page=document,scope=window,command){
  const owns=element=>element===video||element?.contains?.(video)===true;
  let adapter=null,levels=[],selected=-1,select=null,playback='unknown',automatic=true;
  try{
    const clappr=[scope.__wasm_player,scope.player].map(player=>player?.core?.activePlayback).find(player=>owns(player?.el));
    if(clappr){
      const type=clappr.getPlaybackType?.();if(type==='live'||type==='vod')playback=type;
      if(Array.isArray(clappr.levels)){
        adapter=clappr;levels=clappr.levels.slice(0,64);selected=clappr.currentLevel;
        select=index=>{clappr.currentLevel=index===-1?-1:levels[index].id??index;};
        selected=levels.findIndex((level,index)=>(level.id??index)===selected);
      }
    }
    if(!adapter&&scope.hls?.media===video&&Array.isArray(scope.hls.levels)){
      adapter=scope.hls;levels=adapter.levels.slice(0,64);selected=adapter.manualLevel;
      if(!Number.isInteger(selected))selected=adapter.autoLevelEnabled?-1:adapter.currentLevel;
      select=index=>{adapter.currentLevel=index;};
      const details=levels.find(level=>typeof level.details?.live==='boolean')?.details;
      if(details)playback=details.live?'live':'vod';
    }
    if(!adapter&&typeof scope.jwplayer==='function'){
      const player=scope.jwplayer();
      if(owns(player?.getContainer?.())&&typeof player.getQualityLevels==='function'&&typeof player.getCurrentQuality==='function'&&typeof player.setCurrentQuality==='function'){
        const values=player.getQualityLevels();
        if(Array.isArray(values)){adapter=player;levels=values.slice(0,64);selected=player.getCurrentQuality();select=index=>player.setCurrentQuality(index);automatic=false;}
      }
    }
    if(!adapter&&typeof scope.videojs?.getPlayers==='function'){
      const player=Object.values(scope.videojs.getPlayers()).slice(0,16).find(player=>owns(player?.el?.())&&typeof player.qualityLevels==='function');
      if(player){
        const values=player.qualityLevels();adapter=player;levels=Array.from(values).slice(0,64);
        selected=levels.every(level=>level.enabled)?-1:levels.findIndex(level=>level.enabled);
        select=index=>{levels.forEach((level,position)=>{level.enabled=index===-1||index===position;});};
      }
    }
  }catch{adapter=null;levels=[];select=null;}
  if(playback==='unknown')playback=video.duration===Infinity?'live':Number.isFinite(video.duration)&&video.duration>0?'vod':'unknown';
  const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<1e10?Math.round(value):null;
  const clean=value=>typeof value==='string'&&!/nan|undefined|https?:|[<>]/i.test(value)?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,80).trim():'';
  const metadata=levels.map(level=>{
    const height=positive(level.height??level.level?.height),bitrate=positive(level.bitrate??level.bandwidth??level.level?.bitrate);
    return {height,bitrate,label:height?`${height}p${bitrate?` · ${Math.round(bitrate/1000)} kbps`:''}`:bitrate?`${Math.round(bitrate/1000)} kbps`:clean(level.label)||null};
  });
  let quality={kind:'unavailable'};
  if(adapter&&levels.length){
    if(levels.length===1)quality={kind:'fixed',label:metadata[0].label||(positive(video.videoHeight)?`${Math.round(video.videoHeight)}p`:null)};
    else if(select){
      const key=Symbol.for('sunday.player.quality-catalog');
      const state=scope[key]??(scope[key]={adapters:new WeakMap()});
      const signature=JSON.stringify(metadata.map((level,index)=>({...level,providerId:typeof levels[index].id==='number'&&Number.isFinite(levels[index].id)?String(levels[index].id):clean(levels[index].id)})));
      let catalog=state.adapters.get(adapter);
      if(!catalog||catalog.video!==video||catalog.signature!==signature){
        catalog={signature,video,id:globalThis.crypto.randomUUID()};state.adapters.set(adapter,catalog);
      }
      const options=metadata.map((level,index)=>({...level,id:`quality-${catalog.id}-${index}`,label:level.label||`Quality ${index+1}`}));
      quality={kind:'selectable',automatic,selection:selected===-1&&automatic?{kind:'auto'}:options[selected]?{kind:'level',id:options[selected].id}:{kind:'unknown'},options};
    }
  }
  const supported=page.pictureInPictureEnabled===true&&typeof video.requestPictureInPicture==='function'&&!video.disablePictureInPicture;
  const presentation={playing:!video.paused,playback,quality,pip:supported?{kind:'available',active:page.pictureInPictureElement===video}:{kind:'unsupported'}};
  if(!command)return presentation;
  const unavailable=reason=>({result:{kind:'unavailable',reason},presentation});
  if(command.kind==='set-quality'){
    if(quality.kind!=='selectable')return unavailable(command.selection.kind==='level'?'stale-quality':'unsupported');
    const index=command.selection.kind==='auto'?-1:quality.options.findIndex(option=>option.id===command.selection.id);
    if(command.selection.kind==='level'&&index===-1)return unavailable('stale-quality');
    if(index===-1&&!automatic)return unavailable('unsupported');
    if(command.selection.kind===quality.selection.kind&&(command.selection.kind==='auto'||command.selection.id===quality.selection.id))
      return {result:{kind:'applied'},presentation};
    try{select(index);return {result:{kind:'applied'},presentation:nativePlayerControls(video,page,scope)};}catch{return unavailable('unsupported');}
  }
  if(command.kind==='set-picture-in-picture'){
    if(!supported)return unavailable('unsupported');
    return (async()=>{
      try{
        if(command.active&&page.pictureInPictureElement!==video)await video.requestPictureInPicture();
        else if(!command.active&&page.pictureInPictureElement===video)await page.exitPictureInPicture();
        return {result:{kind:'applied'},presentation:nativePlayerControls(video,page,scope)};
      }catch{return unavailable('unsupported');}
    })();
  }
  return unavailable('unsupported');
}

module.exports={nativePlayerControls};
