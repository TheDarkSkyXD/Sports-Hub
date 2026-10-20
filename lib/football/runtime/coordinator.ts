import {z} from 'zod';
import {FootballStore} from '../adapters/store.ts';
import {PartialListingReadError,type FootballDependencies} from '../domain/ports.ts';
import {CandidateSchema,CandidateLocatorSchema,LeagueSchema,ObservationSchema,ReplySchema,VerificationTargetSchema,type Command,type Reply} from '../shared.ts';

const TokenSchema=z.object({id:z.number(),epoch:z.number(),healthRevision:z.number()});
const TargetSchema=VerificationTargetSchema.extend({sessionId:z.string()});
const NativeReplySchema=z.union([ReplySchema,z.object({kind:z.literal('verification-authorized'),candidate:CandidateSchema,target:TargetSchema,deadline:z.number().int().nonnegative()})]);
const SourceSchema=z.object({id:z.string(),url:z.string(),family:z.string(),kind:z.enum(['catalog','pending','browser-catalog']).optional(),name:z.string().optional(),publicUrls:z.array(z.string()).optional(),publicCategories:z.array(z.object({league:LeagueSchema,url:z.string()})).optional(),parserVersion:z.number().optional(),leagues:z.array(LeagueSchema).optional()});
const ScheduleSchema=z.object({id:z.string(),league:LeagueSchema,sport:z.enum(['football','basketball','hockey','baseball','racing','mma']).optional(),path:z.string(),group:z.union([z.string(),z.number()]).nullable().transform(group=>group===null?null:String(group))});
const EffectSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('schedule'),token:TokenSchema,source:ScheduleSchema,at:z.number()}),
  z.object({kind:z.literal('membership'),token:TokenSchema,season:z.number()}),
  z.object({kind:z.literal('listing'),token:TokenSchema,source:SourceSchema,at:z.number()}),
  z.object({kind:z.literal('detail'),token:TokenSchema,observation:ObservationSchema,gameId:z.string(),at:z.number()}),
  z.object({kind:z.literal('resolve'),token:TokenSchema,observation:ObservationSchema,gameId:z.string(),body:z.string(),at:z.number()}),
  z.object({kind:z.literal('verify'),token:TokenSchema,locator:CandidateLocatorSchema,target:TargetSchema}),
  z.object({kind:z.literal('id'),token:TokenSchema}),
  z.object({kind:z.literal('close-schedule'),token:TokenSchema}),
  z.object({kind:z.literal('metadata'),token:TokenSchema,locators:z.array(CandidateLocatorSchema)}),
  z.object({kind:z.literal('flush-probes'),token:TokenSchema}),
]);
const BatchSchema=z.object({replies:z.array(z.object({requestId:z.number(),value:NativeReplySchema})),launch:z.array(EffectSchema),cancel:z.array(TokenSchema),wake:z.object({at:z.number(),version:z.number()}).nullable()});
type Effect=z.infer<typeof EffectSchema>;
type Token=z.infer<typeof TokenSchema>;
type Pending={resolve:(reply:Reply)=>void;reject:(error:unknown)=>void};

export class FootballCoordinator {
  private readonly dependencies:FootballDependencies;
  private readonly pipeline:ReturnType<FootballStore['nativePipeline']>;
  private readonly pending=new Map<number,Pending>();
  private readonly effects=new Map<number,AbortController>();
  private readonly fixtureClock:boolean;
  private readonly fixtureSources:boolean;
  private sourceConfiguration:string;
  private nextRequest=0;
  private wake:ReturnType<typeof setTimeout>|undefined;
  private closing:Promise<void>|undefined;
  private readonly inputs:unknown[]=[];
  private draining=false;

  constructor(dependencies:FootballDependencies,fixtureOperations:readonly string[]=Object.keys(dependencies)) {
    if(!(dependencies.store instanceof FootballStore))throw new Error('The pipeline requires the native football repository.');
    this.dependencies=dependencies;
    this.fixtureClock=fixtureOperations.includes('now');
    this.fixtureSources=fixtureOperations.includes('sources');
    this.sourceConfiguration=JSON.stringify(dependencies.sources);
    this.pipeline=dependencies.store.nativePipeline(JSON.stringify({sources:dependencies.sources,schedules:dependencies.schedules,
      browserCollectorsAvailable:dependencies.browserCollectorsAvailable===true,probeConcurrency:dependencies.probeCandidate.concurrency??2,
      now:this.fixtureClock?dependencies.now():undefined,fixtureOperations}));
    queueMicrotask(()=>this.step({kind:'wake'}));
  }

  start():void {this.step({kind:'start'});}
  async refresh(force=false):Promise<void> {await this.request(requestId=>({kind:'refresh',requestId,force}));}
  command(value:Command):Promise<Reply> {return this.request(requestId=>({kind:'command',requestId,value}));}
  stop():Promise<void> {
    return this.closing??=this.command({kind:'stop'}).then(async()=>{
      if(this.wake)clearTimeout(this.wake);
      this.wake=undefined;
      await this.dependencies.closeSchedule?.();
    });
  }

  private request(input:(requestId:number)=>unknown):Promise<Reply> {
    const requestId=++this.nextRequest;
    return new Promise((resolve,reject)=>{
      this.pending.set(requestId,{resolve,reject});
      try {this.step(input(requestId));}catch(error){this.pending.delete(requestId);reject(error);}
    });
  }

  private step(input:unknown):void {
    if(this.fixtureSources){
      const sources=JSON.stringify(this.dependencies.sources);
      if(sources!==this.sourceConfiguration){this.sourceConfiguration=sources;this.inputs.push({kind:'configure',sources:this.dependencies.sources});}
    }
    this.inputs.push(input);
    if(this.draining)return;
    this.draining=true;
    try {while(this.inputs.length)this.apply(this.inputs.shift());}
    finally{this.draining=false;}
  }

  private apply(input:unknown):void {
    const batch=BatchSchema.parse(JSON.parse(this.pipeline.step(JSON.stringify(input),this.fixtureClock?this.dependencies.now():undefined)));
    if(this.wake)clearTimeout(this.wake);
    this.wake=undefined;
    for(const token of batch.cancel)this.effects.get(token.id)?.abort(new Error('request-cancelled'));
    for(const reply of batch.replies){const pending=this.pending.get(reply.requestId);this.pending.delete(reply.requestId);pending?.resolve(reply.value);}
    if(batch.wake){this.wake=setTimeout(()=>this.step({kind:'wake'}),Math.min(2_147_483_647,Math.max(0,batch.wake.at-this.dependencies.now())));this.wake.unref();}
    for(const effect of batch.launch){
      const controller=new AbortController();this.effects.set(effect.token.id,controller);
      if(effect.kind==='id'){
        try{this.complete(effect.token,this.dependencies.id());}
        catch(error){this.complete(effect.token,{kind:'error',message:error instanceof Error?error.message:'request-failed'});}
        continue;
      }
      if(effect.kind==='verify'){
        let settled=false;
        const finish=(result:unknown)=>{
          if(settled)return;
          settled=true;
          controller.signal.removeEventListener('abort',abort);
          this.complete(effect.token,result);
        };
        const fail=(error:unknown)=>finish({kind:'error',message:error instanceof Error?error.message:'request-failed',retryAfterMs:this.dependencies.retryAfterMs(error)});
        const abort=()=>fail(controller.signal.reason);
        controller.signal.addEventListener('abort',abort,{once:true});
        try{void this.dependencies.probeCandidate(effect.locator,controller.signal,value=>{
          if(!controller.signal.aborted)this.step({kind:'progress',token:effect.token,value});
        },effect.target).then(finish,fail);}
        catch(error){fail(error);}
        continue;
      }
      void this.external(effect,controller.signal).then(
        result=>this.complete(effect.token,result),
        error=>this.complete(effect.token,{kind:'error',message:error instanceof Error?error.message:'request-failed',retryAfterMs:this.dependencies.retryAfterMs(error)}),
      );
    }
  }

  private complete(token:Token,result:unknown):void {
    this.effects.delete(token.id);
    try {this.step({kind:'complete',token,result});}
    catch(error){for(const pending of this.pending.values())pending.reject(error);this.pending.clear();}
  }

  private async external(effect:Exclude<Effect,{kind:'id'|'verify'}>,signal:AbortSignal):Promise<unknown> {
    signal.throwIfAborted();
    const ports=this.dependencies;
    const progress=(value:unknown)=>{if(!signal.aborted)this.step({kind:'progress',token:effect.token,value});};
    switch(effect.kind){
      case 'schedule':return ports.readSchedule(effect.source,effect.at,signal,progress);
      case 'membership':return ports.readSeasonMembership(effect.season,signal);
      case 'listing':{
        try {const body=await ports.readHtml(effect.source.url,signal);return ports.parseListings(effect.source,body,ports.now());}
        catch(error){if(!(error instanceof PartialListingReadError))throw error;
          return {...ports.parseListings(effect.source,error.html,ports.now()),partial:{failure:error.message,retryAfterMs:error.retryAfterMs}};}
      }
      case 'detail':{
        const body=await ports.readHtml(effect.observation.url,signal);
        return {body,observation:ports.enrichObservation(effect.observation,body)};
      }
      case 'resolve':{
        const players=ports.resolvePlayers?await ports.resolvePlayers(effect.gameId,effect.observation,effect.body,signal):
          ['tvapp','tvapp-nba','tvapp-nhl','tvapp-mlb'].includes(effect.observation.sourceId)&&ports.tvappPlayers?
            await ports.tvappPlayers(effect.gameId,effect.observation,effect.body,signal):ports.compatiblePlayers?.(effect.gameId,effect.observation,effect.body)??[];
        return {players,reason:players.length?undefined:ports.missingPlayerReason(effect.observation,effect.body)};
      }
      case 'close-schedule':await ports.closeSchedule?.();return null;
      case 'metadata':return {
        identities:Object.fromEntries(effect.locators.map(locator=>[JSON.stringify(locator),ports.probeIdentity?.(locator)??JSON.stringify(locator)])),
        persistable:Object.fromEntries(effect.locators.map(locator=>[JSON.stringify(locator),Boolean(ports.persistableLocator?.(locator))])),
      };
      case 'flush-probes':await new Promise<void>(resolve=>setImmediate(resolve));return null;
      default:{const exhaustive:never=effect;return exhaustive;}
    }
  }
}
