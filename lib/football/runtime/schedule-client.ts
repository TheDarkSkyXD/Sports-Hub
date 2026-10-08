import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { ScheduleResult, ScheduleSource } from '../domain/ports.ts';

type WorkerEvent =
  | {kind:'current';id:number;result:ScheduleResult}
  | {kind:'complete';id:number;result:ScheduleResult}
  | {kind:'failed';id:number;failure:{code:string;message:string}};
type Pending={signal:AbortSignal;onCurrent?: (result:ScheduleResult)=>void;
  resolve:(result:ScheduleResult)=>void;reject:(error:Error)=>void;onAbort:()=>void};

export class ScheduleWorkerClient {
  private readonly workerFactory:()=>Worker;
  private worker:Worker|undefined;
  private readonly pending=new Map<number,Pending>();
  private nextId=0;
  private generation=0;
  private restartAfter=0;
  private closed=false;
  constructor(workerFactory:()=>Worker=()=>new Worker(join(process.cwd(),'lib','football','runtime','schedule-worker.ts'),{
    execArgv:['--experimental-strip-types'],
  })) {this.workerFactory=workerFactory;}
  private open():void {
    if(this.closed||this.worker||Date.now()<this.restartAfter)return;
    const generation=++this.generation;
    const worker=this.workerFactory();
    this.worker=worker;
    worker.on('message',(event:WorkerEvent)=>{
      if(this.generation===generation)this.receive(event);
    });
    const failed=()=>{
      if(this.closed||this.generation!==generation)return;
      this.worker=undefined;
      this.restartAfter=Date.now()+1000;
      this.failAll(new Error('schedule-worker-unavailable'));
    };
    worker.on('error',failed);
    worker.on('exit',failed);
  }
  readSchedule(partition:ScheduleSource,now:number,signal:AbortSignal,onCurrent?: (result:ScheduleResult)=>void):Promise<ScheduleResult> {
    if(signal.aborted)return Promise.reject(signal.reason);
    this.open();
    if(!this.worker)return Promise.reject(new Error('schedule-worker-unavailable'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const onAbort=()=>{
        this.pending.delete(id);
        this.worker?.postMessage({kind:'cancel',id});
        reject(signal.reason ?? new DOMException('Aborted','AbortError'));
      };
      this.pending.set(id,{signal,onCurrent,resolve,reject,onAbort});
      signal.addEventListener('abort',onAbort,{once:true});
      try {this.worker?.postMessage({kind:'read',id,partitionId:partition.id,now});}
      catch(error) {
        signal.removeEventListener('abort',onAbort);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private receive(event:WorkerEvent):void {
    const pending=this.pending.get(event.id);
    if(!pending||pending.signal.aborted)return;
    if(event.kind==='current') {
      try {pending.onCurrent?.(event.result);}
      catch(error) {
        pending.signal.removeEventListener('abort',pending.onAbort);
        this.pending.delete(event.id);
        try {this.worker?.postMessage({kind:'cancel',id:event.id});} catch {}
        pending.reject(error instanceof Error?error:new Error('schedule-callback-failed'));
      }
      return;
    }
    if(event.kind==='complete'||event.kind==='failed') {
      pending.signal.removeEventListener('abort',pending.onAbort);
      this.pending.delete(event.id);
      if(event.kind==='complete')pending.resolve(event.result);
      else pending.reject(new Error(event.failure.code));
    }
  }
  private failAll(error:Error):void {
    for(const [id,pending] of this.pending) {
      pending.signal.removeEventListener('abort',pending.onAbort);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
  async close():Promise<void> {
    if(this.closed)return;
    this.closed=true;
    this.failAll(new Error('schedule-worker-stopped'));
    const worker=this.worker;
    this.worker=undefined;
    if(worker) {
      let timeout:ReturnType<typeof setTimeout>|undefined;
      try {await Promise.race([worker.terminate(),new Promise<void>(resolve=>{timeout=setTimeout(resolve,2000);})]);}
      finally {clearTimeout(timeout);}
    }
  }
}
