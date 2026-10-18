'use client';

import {useEffect,useRef,useState} from 'react';
import {PlayerControlsSnapshotSchema,type PlayerControlsSnapshot,type PlayerShortcut,type PlayerUiAction} from '@/lib/desktop-player';
import {PlayerControlsSurface,presentationQuality} from './player-controls-surface';

const shortcuts:Partial<Record<string,PlayerShortcut>>={
  ' ':'toggle-playing',m:'toggle-audible',f:'toggle-room-fullscreen',t:'toggle-theater',
  '1':'focus-player-1','2':'focus-player-2','3':'focus-player-3','4':'focus-player-4',Escape:'escape',
};

export function PlayerControlsOverlay(){
  const root=useRef<HTMLDivElement>(null);
  const [snapshot,setSnapshot]=useState<PlayerControlsSnapshot|null>(null);
  const current=useRef(snapshot);
  useEffect(()=>{current.current=snapshot;},[snapshot]);
  useEffect(()=>{
    document.documentElement.classList.add('player-controls-document');
    const bridge=window.sundayPlayerControls;
    let active=true;
    let receivedEvent=false;
    const receive=(value:unknown)=>{
      const parsed=PlayerControlsSnapshotSchema.safeParse(value);
      if(active)setSnapshot(parsed.success?parsed.data:null);
    };
    const unsubscribe=bridge?.subscribe(value=>{receivedEvent=true;receive(value);})??(()=>{});
    void bridge?.ready().then(value=>{if(!receivedEvent)receive(value);},()=>{if(!receivedEvent)receive(null);});
    return()=>{active=false;unsubscribe();document.documentElement.classList.remove('player-controls-document');};
  },[]);
  const dispatch=(binding:string,action:PlayerUiAction)=>{
    const bridge=window.sundayPlayerControls;
    if(!bridge)return Promise.resolve({kind:'unavailable'} as const);
    return bridge.dispatch({binding,action});
  };
  useEffect(()=>{
    const keydown=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||event.ctrlKey||event.altKey||event.metaKey)return;
      const target=event.target;
      if(target instanceof HTMLElement&&(target.isContentEditable||target.closest('input, textarea, select, button')))return;
      const shortcut=shortcuts[event.key.length===1?event.key.toLowerCase():event.key];
      if(!shortcut)return;
      event.preventDefault();
      const binding=current.current?.binding;
      if(binding)void dispatch(binding,{kind:'shortcut',shortcut}).catch(()=>{});
    };
    window.addEventListener('keydown',keydown);
    return()=>window.removeEventListener('keydown',keydown);
  },[]);
  if(!snapshot)return <div ref={root} className="player-controls-overlay"/>;
  const presentation=snapshot.presentation;
  const boundDispatch=(action:PlayerUiAction)=>dispatch(snapshot.binding,action);
  return <div ref={root} className="native-player player-focused player-controls-overlay">
    <PlayerControlsSurface key={snapshot.binding} interactionRoot={root} label={snapshot.label} playing={snapshot.playing}
      audible={snapshot.audible} volume={snapshot.volume} playback={presentation?.playback??'unknown'}
      quality={presentationQuality(presentation?.quality)} pictureInPicture={presentation?.pip??{kind:'unsupported'}}
      fullscreen={snapshot.fullscreen}
      onPlayingChange={playing=>void boundDispatch({kind:'set-playing',playing}).catch(()=>{})}
      onAudibleChange={audible=>void boundDispatch({kind:'set-audible',audible}).catch(()=>{})}
      onVolumeChange={volume=>void boundDispatch({kind:'set-volume',volume}).catch(()=>{})}
      onQualityChange={selection=>boundDispatch({kind:'set-quality',selection})}
      onPictureInPictureChange={active=>boundDispatch({kind:'set-picture-in-picture',active})}
      onFullscreenChange={fullscreen=>boundDispatch({kind:'set-fullscreen',fullscreen})}/>
  </div>;
}
