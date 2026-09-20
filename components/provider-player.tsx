'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw, X } from 'lucide-react';

type PlayerStatus = { id:string; requestId?:string; state:'ready'|'playing'|'error'; message?:string; label?:string; server?:number };
declare global {
 interface Window {
  sundayDesktop?: {
   openGame(id:string,server?:number,requestId?:string):Promise<{serverCount:number;label:string;server:number}>;
   closeGame(id:string):Promise<void>;
   layout(items:{id:string;x:number;y:number;width:number;height:number;hidden:boolean}[]):void;
   controls(value:{audio:string;muted:boolean;volume:number;playing:boolean;overlayOpen:boolean}):void;
   setFullscreen(value:boolean):Promise<boolean>;
   onFullscreenChange(callback:(fullscreen:boolean)=>void):()=>void;
   onOverlayEscape(callback:()=>void):()=>void;
   subscribe(callback:(message:PlayerStatus)=>void):()=>void;
  };
 }
}
export function ProviderPlayer({gameId,obscured,playing,layoutKey,onAvailability,onClose}:{gameId:string;obscured:boolean;playing:boolean;layoutKey:string;onAvailability:(id:string,ready:boolean)=>void;onClose:()=>void}) {
 const ref=useRef<HTMLDivElement>(null);
 const currentServer=useRef(0);
 const [state,setState]=useState('loading'),[message,setMessage]=useState('Finding your game…'),[server,setServer]=useState(0),[count,setCount]=useState(1),[label,setLabel]=useState('Primary');
 useEffect(()=>{onAvailability(gameId,state==='playing');return()=>onAvailability(gameId,false);},[gameId,state,onAvailability]);
 useEffect(()=>{
  const desktop=window.sundayDesktop;if(!desktop)return;
  const requestId=crypto.randomUUID();
  let active=true;setState('loading');setMessage('Finding your game…');
  const unsubscribe=desktop.subscribe(m=>{if(m.id!==gameId||m.requestId!==requestId||!active)return;setState(m.state);setMessage(m.message||'Starting the live player…');if(m.label)setLabel(m.label);if(m.server!==undefined)currentServer.current=m.server;});
  void desktop.openGame(gameId,currentServer.current,requestId).then(result=>{if(active){setCount(result.serverCount);setLabel(result.label);currentServer.current=result.server;}}).catch(error=>{if(active){setState('error');setMessage((error.message||'Couldn’t open this game.').replace(/^Error invoking remote method '[^']+': Error: /,''));}});
  return()=>{active=false;unsubscribe();void desktop.closeGame(gameId).catch(()=>{});};
 },[gameId,server]);
 useLayoutEffect(()=>{
  const desktop=window.sundayDesktop;if(!desktop)return;
  let frame=0;
  const send=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{desktop.layout(Array.from(document.querySelectorAll<HTMLElement>('[data-provider-surface]')).map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.providerSurface!,x:r.x,y:r.y,width:r.width,height:r.height,hidden:el.dataset.hidden==='true'||r.width===0||r.height===0};}));});};
  const observer=new ResizeObserver(send);if(ref.current)observer.observe(ref.current);window.addEventListener('resize',send);window.addEventListener('scroll',send,true);document.addEventListener('fullscreenchange',send);send();
  // Native views may finish resolving after the first layout message.
  const timer=setInterval(send,500);
  return()=>{cancelAnimationFrame(frame);clearInterval(timer);observer.disconnect();window.removeEventListener('resize',send);window.removeEventListener('scroll',send,true);document.removeEventListener('fullscreenchange',send);};
 },[gameId,obscured,state,layoutKey]);
 const nextServer=()=>{currentServer.current=(currentServer.current+1)%Math.max(1,count);setServer(s=>s+1);};
 return <div className="provider-player"><div className="provider-surface" ref={ref} data-provider-surface={gameId} data-hidden={obscured||state==='error'}>
  {(state==='loading'||state==='error')&&<div className="player-message" role="status">{state==='error'?<AlertCircle/>:<LoaderCircle className="spin"/>}<strong>{state==='error'?'This server couldn’t start':'Opening the live player'}</strong><p>{message}</p>{state==='error'&&<button className="button" onClick={nextServer}><RefreshCw size={14}/>Try another server</button>}</div>}
 </div><div className="provider-controls"><span role="status">{state==='playing'?(playing?'Playing':'Paused'):state==='error'?'Unavailable':state==='ready'?message:'Connecting'} · {label}</span><button onClick={nextServer} aria-label="Switch server" title={`Switch provider server (${count} available)`}><RefreshCw size={12}/>Switch server</button><button aria-label="Stop this game" onClick={onClose}><X size={13}/></button></div></div>;
}
