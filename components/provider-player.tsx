'use client';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw, X } from 'lucide-react';

type PlayerStatus = { id:string; state:'ready'|'playing'|'error'; message?:string; label?:string; server?:number };
declare global {
 interface Window {
  sundayDesktop?: {
   openGame(id:string,server?:number):Promise<{serverCount:number;label:string;server:number}>;
   closeGame(id:string):Promise<void>;
   layout(items:{id:string;x:number;y:number;width:number;height:number;hidden:boolean}[]):void;
   controls(value:{audio:string;muted:boolean;volume:number;playing:boolean}):void;
   subscribe(callback:(message:PlayerStatus)=>void):()=>void;
  };
 }
}
export function ProviderPlayer({gameId,obscured,onClose}:{gameId:string;obscured:boolean;onClose:()=>void}) {
 const ref=useRef<HTMLDivElement>(null);
 const currentServer=useRef(0);
 const [state,setState]=useState('loading'),[message,setMessage]=useState('Finding your game…'),[server,setServer]=useState(0),[count,setCount]=useState(1),[label,setLabel]=useState('Primary');
 useEffect(()=>{
  const desktop=window.sundayDesktop;if(!desktop)return;
  let active=true;setState('loading');setMessage('Finding your game…');
  const unsubscribe=desktop.subscribe(m=>{if(m.id!==gameId||!active)return;setState(m.state);if(m.message)setMessage(m.message);if(m.label)setLabel(m.label);if(m.server!==undefined)currentServer.current=m.server;});
  void desktop.openGame(gameId,currentServer.current%6).then(result=>{if(active){setCount(result.serverCount);setLabel(result.label);currentServer.current=result.server;}}).catch(error=>{if(active){setState('error');setMessage((error.message||'Couldn’t open this game.').replace(/^Error invoking remote method '[^']+': Error: /,''));}});
  return()=>{active=false;unsubscribe();void desktop.closeGame(gameId).catch(()=>{});};
 },[gameId,server]);
 useEffect(()=>{
  const desktop=window.sundayDesktop;if(!desktop)return;
  let frame=0;
  const send=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{desktop.layout(Array.from(document.querySelectorAll<HTMLElement>('[data-provider-surface]')).map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.providerSurface!,x:r.x,y:r.y,width:r.width,height:r.height,hidden:el.dataset.hidden==='true'||r.width===0||r.height===0};}));});};
  const observer=new ResizeObserver(send);if(ref.current)observer.observe(ref.current);window.addEventListener('resize',send);window.addEventListener('scroll',send,true);document.addEventListener('fullscreenchange',send);send();
  // Native views may finish resolving after the first layout message.
  const timer=setInterval(send,500);
  return()=>{cancelAnimationFrame(frame);clearInterval(timer);observer.disconnect();window.removeEventListener('resize',send);window.removeEventListener('scroll',send,true);document.removeEventListener('fullscreenchange',send);};
 },[gameId,obscured,state]);
 const nextServer=()=>{currentServer.current+=1;setServer(s=>s+1);};
 return <div className="provider-player"><div className="provider-surface" ref={ref} data-provider-surface={gameId} data-hidden={obscured||state==='error'}>
  <div className="player-message">{state==='error'?<AlertCircle/>:<LoaderCircle className="spin"/>}<strong>{state==='error'?'This server couldn’t start':'Opening the live player'}</strong><p>{message}</p>{state==='error'&&<button className="button" onClick={nextServer}><RefreshCw size={14}/>Try another server</button>}</div>
 </div><div className="provider-controls"><span>{state==='playing'?'Playing':state==='error'?'Unavailable':state==='ready'?'Player ready':'Connecting'} · {label}</span><button onClick={nextServer} title={`Switch provider server (${count} available)`}><RefreshCw size={12}/>Switch server</button><button aria-label="Stop this game" onClick={onClose}><X size={13}/></button></div></div>;
}
