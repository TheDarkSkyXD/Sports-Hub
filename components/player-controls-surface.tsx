'use client';

import {useEffect,useRef,useState,type RefObject} from 'react';
import {Popover} from 'radix-ui';
import {Maximize,Minimize,Pause,PictureInPicture2,Play,Radio,Settings2,Volume2,VolumeX} from 'lucide-react';
import type {PlayerPresentation,PlayerUiResult,QualitySelection} from '@/lib/desktop-player';

export type PlayerControlsQuality=Extract<PlayerPresentation['quality'],{kind:'selectable'}>|{kind:'message';text:string};
type Props={
  interactionRoot:RefObject<HTMLElement|null>;
  label:string;
  playing:boolean;
  audible:boolean;
  volume:number;
  playback:PlayerPresentation['playback'];
  quality:PlayerControlsQuality;
  pictureInPicture:PlayerPresentation['pip'];
  fullscreen:boolean;
  onPlayingChange:(playing:boolean)=>void;
  onAudibleChange:(audible:boolean)=>void;
  onVolumeChange:(volume:number)=>void;
  onQualityChange:(selection:QualitySelection)=>Promise<PlayerUiResult>;
  onPictureInPictureChange:(active:boolean)=>Promise<PlayerUiResult>;
  onFullscreenChange:(active:boolean)=>Promise<PlayerUiResult>;
};

export function presentationQuality(quality:PlayerPresentation['quality']|undefined):PlayerControlsQuality{
  if(quality?.kind==='selectable')return quality;
  if(quality?.kind==='fixed')return {kind:'message',text:`${quality.label?`${quality.label} · `:''}This feed has one quality`};
  return {kind:'message',text:'Quality is unavailable for this stream'};
}

export function PlayerControlsSurface({interactionRoot,label,playing,audible,volume,playback,quality,pictureInPicture,fullscreen,
  onPlayingChange,onAudibleChange,onVolumeChange,onQualityChange,onPictureInPictureChange,onFullscreenChange}:Props){
  const pointerTimer=useRef<number|null>(null),pointerActiveRef=useRef(false);
  const [pointerActive,setPointerActive]=useState(false),[settings,setSettings]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{
    const root=interactionRoot.current;
    if(!root)return;
    const hide=()=>{
      if(pointerTimer.current!==null)window.clearTimeout(pointerTimer.current);
      pointerTimer.current=null;
      if(pointerActiveRef.current){pointerActiveRef.current=false;setPointerActive(false);}
    };
    const show=(event:PointerEvent)=>{
      if(event.pointerType!=='mouse')return;
      if(!pointerActiveRef.current){pointerActiveRef.current=true;setPointerActive(true);}
      if(pointerTimer.current!==null)window.clearTimeout(pointerTimer.current);
      pointerTimer.current=window.setTimeout(()=>{
        pointerTimer.current=null;
        if(pointerActiveRef.current){pointerActiveRef.current=false;setPointerActive(false);}
      },3000);
    };
    root.addEventListener('pointerenter',show);
    root.addEventListener('pointermove',show);
    root.addEventListener('pointerleave',hide);
    return()=>{
      root.removeEventListener('pointerenter',show);
      root.removeEventListener('pointermove',show);
      root.removeEventListener('pointerleave',hide);
      if(pointerTimer.current!==null)window.clearTimeout(pointerTimer.current);
      pointerTimer.current=null;
      pointerActiveRef.current=false;
    };
  },[interactionRoot]);
  useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(''),4000);return()=>window.clearTimeout(timer);},[notice]);

  const apply=async(action:()=>Promise<PlayerUiResult>,unavailable:string)=>{
    try{if((await action()).kind==='unavailable')setNotice(unavailable);}
    catch{setNotice(unavailable);}
  };
  const selectQuality=(selection:QualitySelection)=>{
    setSettings(false);
    void apply(()=>onQualityChange(selection),'That quality is unavailable for this stream.');
  };
  const togglePictureInPicture=()=>void apply(
    ()=>onPictureInPictureChange(!(pictureInPicture.kind==='available'&&pictureInPicture.active)),
    'Picture in picture is unavailable for this stream.',
  );
  const toggleFullscreen=()=>void apply(()=>onFullscreenChange(!fullscreen),'Fullscreen is unavailable for this stream.');

  return <>
    {notice&&<div className="player-notice" role="status">{notice}</div>}
    <div className="player-controls" data-pointer-active={pointerActive||undefined} data-settings-open={settings||undefined}
      data-fullscreen={fullscreen||undefined}
      role="group" aria-label="Focused stream controls">
      <div className="player-control-row">
        <button aria-label={playing?'Pause stream':'Play stream'} title={playing?'Pause focused game (Space)':'Play focused game (Space)'}
          onClick={()=>onPlayingChange(!playing)}>{playing?<Pause size={17} fill="currentColor"/>:<Play size={17} fill="currentColor"/>}</button>
        <button aria-label={audible?'Mute stream':'Unmute stream'} title="Toggle focused audio (M)"
          onClick={()=>onAudibleChange(!audible)}>{audible?<Volume2 size={17}/>:<VolumeX size={17}/>}</button>
        <input className="player-volume" type="range" min="0" max="100" step="1" value={volume} aria-label="Stream volume"
          onChange={event=>onVolumeChange(Number(event.target.value))}/>
        <span className="player-source">{label}</span>
        {playback==='live'&&<span className="player-live"><Radio size={10}/>LIVE</span>}
        {pictureInPicture.kind==='available'&&<button aria-label={pictureInPicture.active?'Exit picture in picture':'Picture in picture'}
          title="Picture in picture" onClick={togglePictureInPicture}><PictureInPicture2 size={17}/></button>}
        <Popover.Root open={settings} onOpenChange={setSettings}>
          <Popover.Trigger asChild><button aria-label="Video quality" title="Quality settings"><Settings2 size={17}/></button></Popover.Trigger>
          <Popover.Portal container={interactionRoot.current??undefined}>
            <Popover.Content className="player-settings" side="top" align="end" sideOffset={6} collisionPadding={8} aria-label="Playback quality">
              <strong>Quality</strong>
              <div className="player-settings-options" role="group" aria-label="Playback quality options">
                {quality.kind==='selectable'?<>
                  {quality.automatic&&<button className={quality.selection.kind==='auto'?'selected':''} onClick={()=>selectQuality({kind:'auto'})}>Auto {quality.selection.kind==='auto'?'✓':''}</button>}
                  {quality.options.map(level=><button key={level.id} className={quality.selection.kind==='level'&&quality.selection.id===level.id?'selected':''}
                    onClick={()=>selectQuality({kind:'level',id:level.id})}>{level.label} {quality.selection.kind==='level'&&quality.selection.id===level.id?'✓':''}</button>)}
                </>:<span>{quality.text}</span>}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <button aria-label={fullscreen?'Exit fullscreen stream':'Fullscreen stream'} title="Fullscreen focused game" onClick={toggleFullscreen}>
          {fullscreen?<Minimize size={17}/>:<Maximize size={17}/>}</button>
      </div>
    </div>
  </>;
}
