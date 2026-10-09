import type { SchedulePermit, SchedulePriority } from '../adapters/schedule.ts';

type PermitJob={origin:string;priority:SchedulePriority;signal:AbortSignal;run:()=>Promise<void>;
  reject:(error:unknown)=>void;onAbort:()=>void};
const priority={current:0,retry:1,history:2,future:3};

export class ScheduleQueue {
  private readonly queue:PermitJob[]=[];
  private readonly activeByOrigin=new Map<string,number>();
  private readonly totalLimit:number;
  private readonly perOriginLimit:number;
  private active=0;
  private scheduled=false;
  constructor(totalLimit=8,perOriginLimit=6) {this.totalLimit=totalLimit;this.perOriginLimit=perOriginLimit;}
  readonly run:SchedulePermit=(url,jobPriority,signal,task)=>{
    if(signal.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
      const origin=new URL(url).origin;
      const job:PermitJob={origin,priority:jobPriority,signal,
        run:async()=>{try {resolve(await task());} catch(error) {reject(error);}},reject,
        onAbort:()=>{
          const index=this.queue.indexOf(job);
          if(index>=0){this.queue.splice(index,1);reject(signal.reason);}
        }};
      signal.addEventListener('abort',job.onAbort,{once:true});
      this.queue.push(job);
      this.schedulePump();
    });
  };
  private schedulePump():void {
    if(this.scheduled)return;
    this.scheduled=true;
    setImmediate(()=>{this.scheduled=false;this.pump();});
  }
  private pump():void {
    this.queue.sort((left,right)=>priority[left.priority]-priority[right.priority]);
    while(this.active<this.totalLimit) {
      const index=this.queue.findIndex(job=>(this.activeByOrigin.get(job.origin)||0)<this.perOriginLimit);
      if(index<0)return;
      const job=this.queue.splice(index,1)[0];
      if(job.signal.aborted){job.signal.removeEventListener('abort',job.onAbort);job.reject(job.signal.reason);continue;}
      this.active++;
      this.activeByOrigin.set(job.origin,(this.activeByOrigin.get(job.origin)||0)+1);
      void job.run().finally(()=>{
        job.signal.removeEventListener('abort',job.onAbort);
        this.active--;
        const remaining=(this.activeByOrigin.get(job.origin)||1)-1;
        if(remaining)this.activeByOrigin.set(job.origin,remaining);
        else this.activeByOrigin.delete(job.origin);
        this.schedulePump();
      });
    }
  }
}
