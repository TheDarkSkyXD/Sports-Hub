import {z} from 'zod';
import {createNativeSchedule} from '../../../native/collector/bridge.cjs';
import {GameSchema,LeagueSchema,SeasonMembershipSchema} from '../shared.ts';
import type {ScheduleProgress,ScheduleSource} from '../domain/ports.ts';

const PartitionSchema=z.object({games:z.array(GameSchema),at:z.number(),week:z.number().optional()});
const ResultSchema=PartitionSchema.extend({league:LeagueSchema,horizonErrors:z.array(z.string()).optional(),history:z.object({kind:z.literal('failed'),day:z.string(),reason:z.string()}).optional()});
const ProgressSchema=ResultSchema.extend({history:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('loading'),day:z.string()}),z.object({kind:z.literal('failed'),day:z.string(),reason:z.string()}),
]).optional()});

export class NativeScheduleClient {
  private readonly native=createNativeSchedule();

  async readSchedule(source:ScheduleSource,at:number,signal:AbortSignal,onCurrent?: (progress:ScheduleProgress)=>void) {
    return this.request(signal,id=>this.native.read(JSON.stringify(source),at,id,json=>{
      if(!signal.aborted)onCurrent?.(ProgressSchema.parse(JSON.parse(json)));
    }),ResultSchema);
  }
  async readSeasonMembership(season:number,signal:AbortSignal) {
    return this.request(signal,id=>this.native.membership(season,id),SeasonMembershipSchema);
  }
  async close():Promise<void> {this.native.close();}

  private async request<T>(signal:AbortSignal,read:(id:number)=>Promise<string>,schema:z.ZodType<T>):Promise<T> {
    signal.throwIfAborted();
    const id=this.native.begin(),cancel=()=>this.native.cancel(id);
    signal.addEventListener('abort',cancel,{once:true});
    try {return schema.parse(JSON.parse(await read(id)));}
    finally {signal.removeEventListener('abort',cancel);}
  }
}
