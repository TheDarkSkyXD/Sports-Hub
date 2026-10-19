'use client';

import {useEffect,useRef,useState,type ComponentProps} from 'react';
import {AlertCircle,LoaderCircle} from 'lucide-react';
import {GamePlayer} from './game-player';
import {monitorPlayerLayout} from './player-layout-monitor';
import {readPresentation,type PresentationResult} from '@/lib/playback/presentation';
import {PlayerStateSchema,PlayerUiActionSchema,type PlayerLayout,type PlayerPresentation,type QualitySelection} from '@/lib/desktop-player';
import {chooseDefaultLevel} from '@/lib/playback-quality';
import type {MediaTimings} from '@/lib/football/shared';

type Props=ComponentProps<typeof GamePlayer>;
export function ManagedPlayer({managed=true,...props}:Props&{managed?:boolean}){
  return managed?<ResolvedPlayer key={props.feed.url} {...props}/>:<GamePlayer {...props}/>;
}

function ResolvedPlayer(props:Props){
  const [result,setResult]=useState<PresentationResult|{kind:'loading'}>({kind:'loading'});
  const [fallback,setFallback]=useState(false);
  const total=props.purpose==='verification'?55000:60000;
  const [remaining,setRemaining]=useState(total);
  const started=useRef(0);
  const decoded=useRef(false),fallbackClaimed=useRef(false);
  const activateFallback=useRef<(url:string)=>void>(()=>{});
  const callbacks=useRef(props);
  useEffect(()=>{callbacks.current=props;},[props]);
  useEffect(()=>{
    started.current=performance.now();
    decoded.current=false;fallbackClaimed.current=false;
    const controller=new AbortController();
    const url=props.feed.url.replace('/index.m3u8?','/presentation?');
    const exhausted:PresentationResult={kind:'deferred',reason:'timeout',phase:'activation'};
    const finish=(value:PresentationResult,deadline:number,isFallback:boolean)=>{
      if(controller.signal.aborted)return;
      const budget=deadline-performance.now();
      const next=value.kind==='ready'&&budget<=3000?exhausted:
        isFallback&&value.kind==='ready'&&value.presentation.kind!=='isolated-embed'?
          {kind:'unavailable' as const,reason:'upstream' as const,phase:'activation' as const}:value;
      if(next.kind==='ready'){
        setRemaining(Math.floor(budget));setFallback(isFallback);setResult(next);return;
      }
      setResult(next);
      if(next.kind==='deferred')callbacks.current.onDeferred?.(props.feed.url,next.reason,{phase:next.phase,retryAfterMs:next.retryAfterMs});
      else callbacks.current.onFatal?.(props.feed.url,next.reason??'upstream',next.phase??'resolution');
    };
    const wait=(delay:number)=>new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,delay);controller.signal.addEventListener('abort',done,{once:true});
    });
    const load=async(target:string,deadline:number,isFallback:boolean)=>{
      while(!controller.signal.aborted){
        const available=deadline-performance.now();
        if(available<=3000){finish(exhausted,deadline,isFallback);return;}
        let value:PresentationResult;
        try{
          const requestBudget=Math.max(1,Math.ceil(Math.min(40000,available-3000)));
          const response=await fetch(target,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(requestBudget)])});
          value=await readPresentation(response);
        }catch(error){
          if(controller.signal.aborted)return;
          value={kind:'deferred',reason:error instanceof Error&&error.name==='TimeoutError'?'timeout':'upstream',phase:'resolution',retryAfterMs:30000};
        }
        if(controller.signal.aborted)return;
        const budget=deadline-performance.now();
        const retryAfterMs=value.kind==='deferred'?Math.max(2000,value.retryAfterMs??30000):0;
        if(value.kind==='deferred'&&props.purpose!=='verification'&&retryAfterMs+3000<budget){
          await wait(retryAfterMs);
          continue;
        }
        finish(value,deadline,isFallback);
        return;
      }
    };
    const startupDeadline=started.current+total;
    activateFallback.current=fallbackUrl=>{
      if(controller.signal.aborted||fallbackClaimed.current)return;
      fallbackClaimed.current=true;
      const now=performance.now();
      const deadline=props.purpose==='verification'||!decoded.current?startupDeadline:now+60000;
      setResult({kind:'loading'});void load(fallbackUrl,deadline,true);
    };
    void load(url,startupDeadline,false);
    return()=>{controller.abort();activateFallback.current=()=>{};};
  },[props.feed.url,props.purpose,total]);
  if(result.kind==='deferred'||result.kind==='unavailable')return <div className="player-message"><AlertCircle/><strong>{result.kind==='deferred'?(props.purpose==='verification'?'Feed is still being checked':'Connection delayed'):"Feed couldn't play"}</strong><button className="button" onClick={()=>props.onRetry?.(props.feed.url)}>Try again</button></div>;
  if(result.kind==='loading')return <div className="player-message"><LoaderCircle className="spin"/><span>Connecting to your feed…</span></div>;
  const presentation=result.presentation;
  const capability=presentation.kind==='isolated-embed'?presentation.capability:null;
  const timings={...result.timings,...(fallback?{fallback:true}:{})};
  if(capability)return <IsolatedPlayer key={capability} {...props} capability={capability} startupTimeoutMs={remaining} timings={timings}/>;
  if(presentation.kind==='isolated-embed')return null;
  const fallbackUrl=presentation.fallbackUrl;
  const url=new URL(presentation.url,new URL(props.feed.url,location.href)).href;
  return <GamePlayer {...props} format={presentation.kind} feed={{...props.feed,url}} startupTimeoutMs={remaining}
    noProgressTimeoutMs={fallbackUrl?Math.min(12000,remaining/2):undefined}
    onDecoded={(_url,proof,mediaTimings)=>{decoded.current=true;props.onDecoded?.(props.feed.url,proof,{...timings,...mediaTimings,path:presentation.kind});}}
    onFatal={(_url,reason,phase)=>{if(fallbackUrl)activateFallback.current(fallbackUrl);else props.onFatal?.(props.feed.url,reason,phase);}}
    onDeferred={(_url,reason,details)=>{if(fallbackUrl&&(reason==='upstream'||reason==='unverified'))activateFallback.current(fallbackUrl);else props.onDeferred?.(props.feed.url,reason,details);}}
    onRetry={()=>props.onRetry?.(props.feed.url)} onEnded={()=>props.onEnded?.(props.feed.url)}/>;
}

function IsolatedPlayer(props:Props&{capability:string;timings:MediaTimings}){
  const {capability}=props;
  const shell=useRef<HTMLDivElement>(null),slot=useRef<HTMLDivElement>(null);
  const callbacks=useRef(props);
  useEffect(()=>{callbacks.current=props;},[props]);
  const [ready,setReady]=useState(false),[failed,setFailed]=useState(false);
  const [deferred,setDeferred]=useState(false);
  const [presentation,setPresentation]=useState<PlayerPresentation>();
  const observed=useRef<PlayerPresentation>(undefined);
  const manualQuality=useRef(false),appliedDefault=useRef('');
  useEffect(()=>{manualQuality.current=false;appliedDefault.current='';},[props.defaultQuality]);
  const quality=presentation?.quality;
  useEffect(()=>{
    if(quality?.kind!=='selectable'||manualQuality.current)return;
    const signature=JSON.stringify([props.defaultQuality,quality.options]);
    if(appliedDefault.current===signature)return;
    const index=chooseDefaultLevel({preference:props.defaultQuality,levels:quality.options.map((level,index)=>({index,height:level.height??0,bitrate:level.bitrate??0}))});
    const option=quality.options[index];
    const selection:QualitySelection=option?{kind:'level',id:option.id}:{kind:'auto'};
    if(selection.kind==='auto'&&!quality.automatic)return;
    appliedDefault.current=signature;
    void window.sundayPlayer?.control({capability,command:{kind:'set-quality',selection}}).catch(()=>{});
  },[capability,props.defaultQuality,quality]);
  useEffect(()=>{
    if(!props.focused&&document.fullscreenElement===shell.current)void document.exitFullscreen().catch(()=>{});
  },[props.focused]);
  useEffect(()=>{
    const handle=(event:Event)=>{
      const detail=event instanceof CustomEvent?event.detail:null;
      if(!detail||detail.capability!==capability)return;
      const parsed=PlayerUiActionSchema.safeParse(detail.action);
      if(!parsed.success)return;
      const action=parsed.data;
      if(action.kind==='set-fullscreen'){
        if(action.fullscreen){if(document.fullscreenElement!==shell.current)void shell.current?.requestFullscreen();}
        else if(document.fullscreenElement===shell.current)void document.exitFullscreen();
        return;
      }
      if(action.kind!=='shortcut')return;
      if(action.shortcut==='escape'&&document.fullscreenElement){void document.exitFullscreen();return;}
      const key={
        'toggle-playing':' ','toggle-audible':'m','toggle-room-fullscreen':'f','toggle-theater':'t',
        'focus-player-1':'1','focus-player-2':'2','focus-player-3':'3','focus-player-4':'4','escape':'Escape',
      }[action.shortcut];
      (shell.current??document.body).dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));
    };
    window.addEventListener('sunday-player-controls-action',handle);
    return()=>window.removeEventListener('sunday-player-controls-action',handle);
  },[capability]);
  useEffect(()=>{
    const bridge=window.sundayPlayer;
    let active=true,proved=false,ended=false,mounted=false,released=false,last='';
    const release=()=>{if(released)return;released=true;void bridge?.release({capability}).catch(()=>{});};
    const fail=(reason:'upstream'|'playback'='playback')=>{
      if(!active||ended)return;ended=true;release();setFailed(true);
      if(reason==='upstream'){
        setDeferred(true);callbacks.current.onDeferred?.(callbacks.current.feed.url,'upstream',{phase:'decode',retryAfterMs:30000});
      }else callbacks.current.onFatal?.(callbacks.current.feed.url,'playback','decode');
    };
    if(!bridge){queueMicrotask(fail);return()=>{active=false;};}
    const unsubscribe=bridge.subscribe(value=>{
      const parsed=PlayerStateSchema.safeParse(value);if(!active||ended||!parsed.success||parsed.data.capability!==capability)return;
      if(parsed.data.kind==='decoded'){proved=true;setReady(true);callbacks.current.onDecoded?.(callbacks.current.feed.url,parsed.data.proof,
        {...callbacks.current.timings,decodeMs:parsed.data.proof.startupMs,path:'isolated-embed'});}
      else if(parsed.data.kind==='presentation'){
        const next=parsed.data.presentation,previous=observed.current;
        observed.current=next;setPresentation(next);
        if((next.pip.kind==='available'&&next.pip.active||previous?.pip.kind==='available'&&previous.pip.active)&&next.playing!==callbacks.current.playing)
          callbacks.current.onPlayingChange(next.playing);
      }
      else if(parsed.data.kind==='action'){
        const action=parsed.data.action;
        if(action.kind==='set-quality')manualQuality.current=true;
        else if(action.kind==='set-playing')callbacks.current.onPlayingChange(action.playing);
        else if(action.kind==='set-audible')callbacks.current.onAudibleChange(action.audible);
        else if(action.kind==='set-volume')callbacks.current.onVolumeChange(action.volume);
        else if(action.kind==='focus-player')callbacks.current.onFocus?.();
      }
      else if(parsed.data.kind==='failed')fail(parsed.data.reason);
      else if(parsed.data.kind==='ended')fail('upstream');
    });
    const sync=(overlay:boolean)=>{
      if(!active||ended||!mounted||!slot.current)return;
      const rect=slot.current.getBoundingClientRect(),current=callbacks.current;
      const covered=[
        [rect.left+1,rect.top+1],[rect.right-1,rect.top+1],[rect.left+1,rect.bottom-1],[rect.right-1,rect.bottom-1],
        [(rect.left+rect.right)/2,(rect.top+rect.bottom)/2],
      ].some(([x,y])=>{if(x<0||y<0||x>=innerWidth||y>=innerHeight)return false;const element=document.elementFromPoint(x,y);return !!element&&!slot.current?.contains(element);});
      const visible=!ended&&!overlay&&!covered&&rect.width>0&&rect.height>0&&
        (current.purpose==='verification'||!document.hidden)&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth;
      const layout:PlayerLayout={capability,bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},visible,
        playing:current.playing,audible:current.audible,volume:current.volume/100,focused:current.focused,
        controls:current.focused&&current.purpose!=='verification'?{label:current.feed.label,fullscreen:document.fullscreenElement===shell.current}:null};
      const signature=JSON.stringify(layout);if(signature===last)return;last=signature;
      void bridge.update(layout).catch(()=>fail('upstream'));
    };
    const monitor=slot.current?monitorPlayerLayout(slot.current,sync):null;
    void bridge.mount({capability}).then(result=>{
      if(!active||ended){release();return;}
      if(result.kind==='capacity'){ended=true;release();setDeferred(true);setFailed(true);callbacks.current.onDeferred?.(callbacks.current.feed.url,'capacity',{phase:'activation',retryAfterMs:2000});return;}
      mounted=true;monitor?.schedule();
    },()=>fail('upstream'));
    const timer=setTimeout(()=>{if(!proved)fail();},props.startupTimeoutMs??20000);
    return()=>{
      active=false;clearTimeout(timer);unsubscribe();monitor?.dispose();
      release();
    };
  },[capability,props.startupTimeoutMs]);
  return <div ref={shell} className="native-player isolated-player">
    <div ref={slot} className="isolated-player-slot" aria-label={props.feed.label}>
      {!ready&&!failed&&<div className="player-message" style={{pointerEvents:'none'}}><LoaderCircle className="spin"/><span>Connecting to your feed…</span></div>}
      {failed&&<div className="player-message"><AlertCircle/><strong>{deferred?(props.purpose==='verification'?'Feed is still being checked':ready?'Connection interrupted':'Connection delayed'):"Feed couldn't play"}</strong><button onClick={()=>props.onRetry?.(props.feed.url)}>Try again</button></div>}
    </div>
  </div>;
}
