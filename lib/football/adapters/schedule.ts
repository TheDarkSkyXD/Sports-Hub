import {z} from 'zod';
import {createNativeSchedule,pipelineDomain,type NativeSchedule} from '../../../native/collector/bridge.cjs';
import {GameSchema,LeagueSchema,SeasonMembershipSchema} from '../shared.ts';
import type {ScheduleProgress,ScheduleResult,ScheduleSource} from '../domain/ports.ts';

const ScheduleSourceSchema=z.object({id:z.string(),league:LeagueSchema,sport:z.enum(['football','basketball','hockey','baseball','racing','mma']).optional(),path:z.string(),group:z.string().nullable()});
export const SCHEDULES=z.array(ScheduleSourceSchema).parse(JSON.parse(pipelineDomain('defaultSchedules','[]')));
const ResultSchema=z.object({games:z.array(GameSchema),at:z.number(),week:z.number().optional(),league:LeagueSchema,
  history:z.object({kind:z.literal('failed'),day:z.string(),reason:z.string()}).optional(),horizonErrors:z.array(z.string()).optional()});
const ProgressSchema=ResultSchema.extend({history:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('loading'),day:z.string()}),z.object({kind:z.literal('failed'),day:z.string(),reason:z.string()}),
]).optional()});
const RequestsSchema=z.array(z.object({method:z.string(),url:z.string(),body:z.string().nullable(),accept:z.string()}));
const clients=new WeakMap<AbortSignal,NativeSchedule>();
function clientFor(signal:AbortSignal):NativeSchedule {
  let client=clients.get(signal);
  if(!client){client=createNativeSchedule();clients.set(signal,client);}
  return client;
}
async function request<T>(native:NativeSchedule,signal:AbortSignal,read:(id:number)=>Promise<string>,schema:z.ZodType<T>):Promise<T> {
  signal.throwIfAborted();
  const id=native.begin(),cancel=()=>native.cancel(id);
  signal.addEventListener('abort',cancel,{once:true});
  try {return schema.parse(JSON.parse(await read(id)));}
  catch(error){
    if(signal.aborted)throw signal.reason;
    if(error instanceof Error&&error.message==='timeout')throw new DOMException('Timed out','TimeoutError');
    if(error instanceof Error&&error.message==='fetch failed')throw new TypeError('fetch failed');
    throw error;
  }
  finally {signal.removeEventListener('abort',cancel);native.cancel(id);}
}
function read(native:NativeSchedule,source:ScheduleSource,now:number,signal:AbortSignal,onCurrent?: (progress:ScheduleProgress)=>void):Promise<ScheduleResult> {
  return request(native,signal,id=>native.read(JSON.stringify(source),now,id,json=>{
    if(!signal.aborted)onCurrent?.(ProgressSchema.parse(JSON.parse(json)));
  }),ResultSchema);
}
export function readSchedule(source:ScheduleSource,now:number,signal:AbortSignal,onCurrent?: (progress:ScheduleProgress)=>void):Promise<ScheduleResult> {
  return read(clientFor(signal),source,now,signal,onCurrent);
}
export function readSeasonMembership(season:number,signal:AbortSignal) {
  return request(clientFor(signal),signal,id=>clientFor(signal).membership(season,id),SeasonMembershipSchema);
}
export type ScheduleFixtureScript={url:string;status?:number;body?:string;failure?:{message:string;retryAfterMs?:number};delayMs?:number;pending?:boolean;gate?:string;chunks?:{body:string;delayMs?:number}[]};
export function createFixtureSchedule() {
  const native=createNativeSchedule(true);
  return {
    readSchedule:(source:ScheduleSource,now:number,signal:AbortSignal,onCurrent?: (progress:ScheduleProgress)=>void)=>read(native,source,now,signal,onCurrent),
    readSeasonMembership:(season:number,signal:AbortSignal)=>request(native,signal,id=>native.membership(season,id),SeasonMembershipSchema),
    enqueueFixture:(script:ScheduleFixtureScript)=>native.enqueueFixture(JSON.stringify(script)),
    releaseFixtureGate:(gate:string)=>native.releaseFixtureGate(gate),
    fixtureRequests:()=>RequestsSchema.parse(JSON.parse(native.fixtureRequests())),
    fixtureCancels:()=>z.array(z.string()).parse(JSON.parse(native.fixtureCancels())),
    close:()=>native.close(),
  };
}
