'use client';

import { useEffect, useRef, useState } from 'react';
import { GamePlayer } from '@/components/game-player';
import type { AdvancingVideo } from '@/lib/playback/advancing-video';

type Assignment={id:string;url:string;slot:0|1};
type Result={kind:'playable';proof:AdvancingVideo}|{kind:'unavailable'}|{kind:'deferred'};
type Bridge={assign:(slot:0|1,id:string,url:string)=>Promise<Result>;cancel:(id:string)=>void};

declare global {interface Window {__sundayVerify?:Bridge}}

export default function PlaybackVerifierPage(){
  const [assignments,setAssignments]=useState<Array<Assignment|null>>([null,null]);
  const finishRef=useRef<(id:string,result:Result)=>void>(()=>{});
  useEffect(()=>{
    const pending=new Map<string,(result:Result)=>void>();
    const finish=(id:string,result:Result)=>{
      const resolve=pending.get(id);
      if(!resolve)return;
      pending.delete(id);
      setAssignments(current=>current.map(item=>item?.id===id?null:item));
      resolve(result);
    };
    finishRef.current=finish;
    window.__sundayVerify={
      assign(slot,id,url){
        if(pending.has(id)||slot!==0&&slot!==1)return Promise.resolve({kind:'deferred'});
        return new Promise(resolve=>{
          pending.set(id,resolve);
          setAssignments(current=>current.map((item,index)=>index===slot?{id,url,slot}:item));
        });
      },
      cancel(id){finish(id,{kind:'deferred'});},
    };
    return()=>{
      delete window.__sundayVerify;
      for(const resolve of pending.values())resolve({kind:'deferred'});
      pending.clear();
    };
  },[]);
  return <main style={{display:'grid',gridTemplateColumns:'1fr 1fr',width:800,height:260}}>
    {assignments.map((assignment,slot)=>assignment?
      <GamePlayer key={assignment.id} purpose="verification" feed={{url:assignment.url,label:'Verification'}}
        focused={false} audible={false} volume={0} defaultQuality="auto" playing={true} startupTimeoutMs={55_000}
        onPlayingChange={()=>{}} onAudibleChange={()=>{}} onVolumeChange={()=>{}}
        onDecoded={(_url,proof)=>finishRef.current(assignment.id,{kind:'playable',proof})}
        onFatal={()=>finishRef.current(assignment.id,{kind:'unavailable'})}
        onEnded={()=>finishRef.current(assignment.id,{kind:'unavailable'})}/>
      :<div key={slot}/>)}
  </main>;
}
