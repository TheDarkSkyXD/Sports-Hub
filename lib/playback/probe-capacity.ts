import {AsyncLocalStorage} from 'node:async_hooks';

type Resource='http'|'observer';
type Progress={kind:'waiting'|'active';since:number};
type Waiter={signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:unknown)=>void;abort:()=>void};

class Permits {
  private active=0;
  private readonly waiting:Waiter[]=[];
  private readonly limit:number;
  constructor(limit:number) {this.limit=limit;}
  acquire(signal:AbortSignal):Promise<()=>void> {
    if(signal.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
      const waiter:Waiter={signal,resolve,reject,abort:()=>{
        const index=this.waiting.indexOf(waiter);
        if(index>=0)this.waiting.splice(index,1);
        reject(signal.reason);
      }};
      signal.addEventListener('abort',waiter.abort,{once:true});
      this.waiting.push(waiter);
      this.drain();
    });
  }
  private drain():void {
    while(this.active<this.limit&&this.waiting.length){
      const waiter=this.waiting.shift()!;
      waiter.signal.removeEventListener('abort',waiter.abort);
      if(waiter.signal.aborted){waiter.reject(waiter.signal.reason);continue;}
      this.active++;
      let released=false;
      waiter.resolve(()=>{
        if(released)return;
        released=true;
        this.active--;
        this.drain();
      });
    }
  }
}

class ProbeScope {
  readonly signal:AbortSignal;
  private readonly budget=new AbortController();
  private readonly onProgress:(progress:Progress)=>void;
  private readonly pools:Record<Resource,Permits>;
  private remaining:number;
  private active=0;
  private waiting=0;
  private started=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private finished=false;
  private readonly httpCleanups=new Set<()=>void>();
  constructor(signal:AbortSignal,onProgress:(progress:Progress)=>void,
    pools:Record<Resource,Permits>,activeBudgetMs:number) {
    this.signal=AbortSignal.any([signal,this.budget.signal]);
    this.onProgress=onProgress;
    this.pools=pools;
    this.remaining=activeBudgetMs;
    this.updateBudget();
  }
  private updateBudget():void {
    if(this.finished||this.signal.aborted)return;
    if(this.active===0&&this.waiting>0){
      if(this.timer){
        clearTimeout(this.timer);
        this.timer=undefined;
        this.remaining-=Date.now()-this.started;
      }
      return;
    }
    if(!this.timer){
      if(this.remaining<=0){this.budget.abort(new DOMException('Media check budget expired','TimeoutError'));return;}
      this.started=Date.now();
      this.timer=setTimeout(()=>this.budget.abort(new DOMException('Media check budget expired','TimeoutError')),this.remaining);
    }
  }
  async acquire(resource:Resource,signal:AbortSignal):Promise<()=>void> {
    const combined=AbortSignal.any([this.signal,signal]);
    if(!this.active)this.onProgress({kind:'waiting',since:Date.now()});
    this.waiting++;
    this.updateBudget();
    let releasePermit:()=>void;
    try{releasePermit=await this.pools[resource].acquire(combined);}
    finally{this.waiting--;this.updateBudget();}
    if(combined.aborted){releasePermit();throw combined.reason;}
    this.active++;
    this.updateBudget();
    this.onProgress({kind:'active',since:Date.now()});
    let released=false;
    return ()=>{
      if(released)return;
      released=true;
      releasePermit();
      this.active--;
      this.updateBudget();
      if(!this.active&&this.waiting&&!this.signal.aborted)this.onProgress({kind:'waiting',since:Date.now()});
    };
  }
  trackHttp(cleanup:()=>void):()=>void {
    this.httpCleanups.add(cleanup);
    return ()=>this.httpCleanups.delete(cleanup);
  }
  cleanupHttp():void {for(const cleanup of this.httpCleanups)cleanup();}
  finish():void {this.finished=true;clearTimeout(this.timer);this.timer=undefined;this.cleanupHttp();}
}

const current=new AsyncLocalStorage<ProbeScope>();

export function createProbeResources(options:{httpLimit:number;observerLimit:number;activeBudgetMs:number}) {
  const pools={http:new Permits(options.httpLimit),observer:new Permits(options.observerLimit)};
  return {
    run<T>(signal:AbortSignal,onProgress:(progress:Progress)=>void,work:(signal:AbortSignal)=>Promise<T>):Promise<T> {
      const scope=new ProbeScope(signal,onProgress,pools,options.activeBudgetMs);
      return current.run(scope,()=>new Promise<T>((resolve,reject)=>{
        if(scope.signal.aborted){reject(scope.signal.reason);return;}
        const abort=()=>{scope.cleanupHttp();reject(scope.signal.reason);};
        scope.signal.addEventListener('abort',abort,{once:true});
        void Promise.resolve().then(()=>work(scope.signal)).then(resolve,reject)
          .finally(()=>{scope.cleanupHttp();scope.signal.removeEventListener('abort',abort);});
      }).finally(()=>scope.finish()));
    },
  };
}

export async function probeObserverLease(signal:AbortSignal):Promise<()=>void> {
  const scope=current.getStore();
  return scope?scope.acquire('observer',signal):()=>{};
}

export async function probeHttpResponse(signal:AbortSignal,work:(active:AbortSignal)=>Promise<Response>,
  timeoutMs?:number):Promise<Response> {
  const scope=current.getStore();
  if(!scope)return work(timeoutMs===undefined?signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]));
  const release=await scope.acquire('http',signal);
  const active=AbortSignal.any([signal,scope.signal,...(timeoutMs===undefined?[]:[AbortSignal.timeout(timeoutMs)])]);
  let response:Response;
  try{response=await work(active);}catch(error){release();throw error;}
  if(!response.body){release();return response;}
  const reader=response.body.getReader();
  let closed=false;
  let untrack=()=>{};
  let bodyController:ReadableStreamDefaultController<Uint8Array>|undefined;
  const finish=()=>{if(closed)return;closed=true;active.removeEventListener('abort',abort);untrack();release();};
  const abort=()=>{
    try{bodyController?.error(active.reason);}catch{}
    void reader.cancel(active.reason).then(finish,finish);
  };
  const body=new ReadableStream<Uint8Array>({
    start(controller){bodyController=controller;},
    async pull(controller){
      try{
        const part=await reader.read();
        if(active.aborted)throw active.reason;
        if(part.done){controller.close();finish();}
        else controller.enqueue(part.value);
      }catch(error){try{controller.error(error);}catch{}finish();}
    },
    async cancel(reason){try{await reader.cancel(reason);}finally{finish();}},
  });
  untrack=scope.trackHttp(abort);
  active.addEventListener('abort',abort,{once:true});
  if(active.aborted)abort();
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}

export function probeFetch(fetcher:typeof fetch,input:RequestInfo|URL,init:RequestInit={},timeoutMs?:number):Promise<Response> {
  return probeHttpResponse(init.signal || new AbortController().signal,signal=>fetcher(input,{...init,signal}),timeoutMs);
}

export const scopedFetch:typeof fetch=(input,init)=>probeFetch(fetch,input,init);

export function timedFetch(fetcher:typeof fetch,input:RequestInfo|URL,init:RequestInit,timeoutMs:number):Promise<Response> {
  if(fetcher===scopedFetch)return probeFetch(fetch,input,init,timeoutMs);
  const signal=init.signal || new AbortController().signal;
  return fetcher(input,{...init,signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)])});
}

export function releaseObserverAfterClose(close:()=>Promise<boolean>,release:()=>void,
  retryMs=5000,expiryMs=5*60_000):void {
  let done=false;
  let retryTimer:ReturnType<typeof setTimeout>|undefined;
  const finish=()=>{
    if(done)return;
    done=true;
    clearTimeout(retryTimer);
    clearTimeout(expiryTimer);
    release();
  };
  const expiryTimer=setTimeout(finish,expiryMs);
  expiryTimer.unref?.();
  const attempt=async()=>{
    if(done)return;
    try{if(await close()){finish();return;}}catch{}
    if(!done){retryTimer=setTimeout(()=>{void attempt();},retryMs);retryTimer.unref?.();}
  };
  void attempt();
}
