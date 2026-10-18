'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ManagedPlayer } from '@/components/managed-player';
import type { MediaCheckResult } from '@/lib/football/shared';
import verificationPolicy from '@/lib/playback/verification-policy.json' with {type:'json'};

type Assignment={id:string;url:string};
type Result=MediaCheckResult;
type Bridge={assign:(id:string,url:string)=>Promise<Result>;cancel:(id:string)=>Promise<void>};

declare global {interface Window {__sundayVerify?:Bridge}}

const VerificationPlayer=memo(function VerificationPlayer({assignment,onResult}:{assignment:Assignment;onResult:(id:string,result:Result)=>void}){
  return <ManagedPlayer purpose="verification" feed={{url:assignment.url,label:'Verification'}}
    focused={false} audible={false} volume={0} defaultQuality="auto" playing={true} startupTimeoutMs={55_000}
    onPlayingChange={()=>{}} onAudibleChange={()=>{}} onVolumeChange={()=>{}}
    onDecoded={(_url,proof,timings)=>onResult(assignment.id,{kind:'playable',proof,...(timings?{timings}:{})})}
    onDeferred={(_url,reason,details)=>onResult(assignment.id,{kind:'deferred',reason,
      retryAfterMs:details?.retryAfterMs??(reason==='capacity'?2000:30000),...(details?.phase?{phase:details.phase}:{})})}
    onFatal={(_url,reason,phase)=>onResult(assignment.id,{kind:'unavailable',reason:reason??'playback',phase:phase??'decode'})}
    onEnded={()=>onResult(assignment.id,{kind:'unavailable',reason:'no-feed'})}/>;
});

export default function PlaybackVerifierPage(){
  const [assignments,setAssignments]=useState<Assignment[]>([]);
  const finishRef=useRef<(id:string,result:Result)=>void>(()=>{});
  const pending=useRef(new Map<string,{promise:Promise<Result>;resolve:(result:Result)=>void}>());
  const completed=useRef(new Map<string,Result>());
  const onResult=useCallback((id:string,result:Result)=>finishRef.current(id,result),[]);
  useEffect(()=>{
    const entries=pending.current,outcomes=completed.current;
    const finish=(id:string,result:Result)=>{
      if(!entries.has(id)||outcomes.has(id))return;
      outcomes.set(id,result);
      setAssignments(current=>current.filter(item=>item.id!==id));
    };
    finishRef.current=finish;
    window.__sundayVerify={
      assign(id,url){
        if(entries.has(id))
          return Promise.resolve({kind:'deferred',retryAfterMs:30000});
        const entry=Promise.withResolvers<Result>();
        entries.set(id,entry);
        setAssignments(current=>[...current,{id,url}]);
        return entry.promise;
      },
      cancel(id){
        const entry=entries.get(id);
        finish(id,{kind:'deferred',retryAfterMs:30000});
        return entry?entry.promise.then(()=>{}):Promise.resolve();
      },
    };
    return()=>{
      delete window.__sundayVerify;
      for(const entry of entries.values())entry.resolve({kind:'deferred',retryAfterMs:30000});
      entries.clear();
      outcomes.clear();
    };
  },[]);
  useEffect(()=>{
    const rendered=new Set(assignments.map(assignment=>assignment.id));
    for(const [id,result] of completed.current)if(!rendered.has(id)){
      const entry=pending.current.get(id);
      pending.current.delete(id);
      completed.current.delete(id);
      entry?.resolve(result);
    }
  },[assignments]);
  return <main style={{display:'grid',gridTemplateColumns:`repeat(${Math.min(4,verificationPolicy.concurrency)},320px)`,
    gridAutoRows:260,width:Math.min(4,verificationPolicy.concurrency)*320,height:Math.ceil(verificationPolicy.concurrency/4)*260}}>
    {assignments.map(assignment=><div key={assignment.id} style={{position:'relative',minWidth:0,minHeight:0}}>
      <VerificationPlayer assignment={assignment} onResult={onResult}/>
    </div>)}
  </main>;
}
