import {z} from 'zod';
import {createNativeStore,type NativeStore,type NativePipeline} from '../../../native/collector/bridge.cjs';
import {LeagueSchema,FinishedGameRetentionMinutesSchema,DetailEvidenceSchema,GameSchema,ObservationSchema,
  SeasonMembershipSchema,SourceAttemptSchema,SourceEventBindingSchema,StoredSportsurgeCatalogSchema,StoredStreameastCatalogSchema} from '../shared.ts';
import type {CollectionAttempt,DetailEvidence,Game,Match,Observation,SeasonMembership,SourceAttempt,SourceEventBinding,
  StoredSportsurgeCatalog,StoredStreameastCatalog} from '../shared.ts';
import {WorkingFeedSchema,type WorkingFeed} from '../domain/working-feed.ts';
import {FeedCheckSchema,type FeedCheck} from '../domain/feed-check.ts';

const PartitionSchema=z.object({games:z.array(GameSchema),at:z.number(),week:z.number().optional()});
export type Partition=z.infer<typeof PartitionSchema>;
const CollectionHistorySchema=z.array(z.object({sourceId:z.string(),league:LeagueSchema.nullable(),at:z.number(),outcome:SourceAttemptSchema.shape.outcome,count:z.number()}));
const SportsurgeHistorySchema=z.object({current:StoredSportsurgeCatalogSchema.nullable(),lastComplete:StoredSportsurgeCatalogSchema.nullable(),previous:StoredSportsurgeCatalogSchema.nullable()});
const StreameastHistorySchema=z.object({current:StoredStreameastCatalogSchema.nullable(),lastComplete:StoredStreameastCatalogSchema.nullable(),previous:StoredStreameastCatalogSchema.nullable()});
function freezePartition(value:unknown):void {
  if(!value||typeof value!=='object'||Object.isFrozen(value))return;
  for(const child of Object.values(value))freezePartition(child);
  Object.freeze(value);
}

export class FootballStore {
  private readonly native:NativeStore;
  private readonly partitionCache=new Map<string,Partition|undefined>();
  private attached=false;

  constructor(path:string,options:{ownerToken?:string;reclaimToken?:string}={}) {
    this.native=createNativeStore(path,options.ownerToken,options.reclaimToken);
  }
  private read<T>(schema:z.ZodType<T>,operation:string,args:readonly unknown[]=[]):T {
    return schema.parse(JSON.parse(this.native.call(operation,JSON.stringify(args))));
  }
  private write(operation:string,...args:unknown[]):void {this.native.call(operation,JSON.stringify(args));}
  nativePipeline(configJson:string):NativePipeline {
    const pipeline=this.native.createPipeline(configJson);
    this.attached=true;
    this.partitionCache.clear();
    return pipeline;
  }
  finishedGameRetentionMinutes():number {return this.read(FinishedGameRetentionMinutesSchema,'finishedGameRetentionMinutes');}
  setFinishedGameRetentionMinutes(value:number):void {
    this.write('setFinishedGameRetentionMinutes',FinishedGameRetentionMinutesSchema.parse(value));
    this.partitionCache.clear();
  }
  partition(id:string):Partition|undefined {
    if(!this.attached&&this.partitionCache.has(id))return this.partitionCache.get(id);
    const partition=this.read(PartitionSchema.nullable(),'partition',[id])??undefined;
    freezePartition(partition);
    if(!this.attached)this.partitionCache.set(id,partition);
    return partition;
  }
  savePartition(id:string,value:Partition):void {this.write('savePartition',id,PartitionSchema.parse(value));this.partitionCache.delete(id);}
  finals():Game[] {return this.read(z.array(GameSchema),'finals');}
  observe(observation:Observation,result:Match):void {this.write('observe',ObservationSchema.parse(observation),result);}
  observations():Observation[] {return this.read(z.array(ObservationSchema),'observations');}
  observation(id:string):Observation|null {return this.read(ObservationSchema.nullable(),'observation',[id]);}
  sourceAttempts():Record<string,SourceAttempt> {return this.read(z.record(SourceAttemptSchema),'sourceAttempts');}
  workingFeeds():WorkingFeed[] {return this.read(z.array(WorkingFeedSchema),'workingFeeds');}
  feedChecks(now:number):FeedCheck[] {return this.read(z.array(FeedCheckSchema),'feedChecks',[now]);}
  saveFeedCheck(check:FeedCheck):void {this.write('saveFeedCheck',FeedCheckSchema.parse(check));}
  removeFeedCheck(gameId:string,identityHash:string):void {this.write('removeFeedCheck',gameId,identityHash);}
  replaceWorkingIdentity(gameId:string,identityHash:string,feeds:readonly WorkingFeed[]):void {
    this.write('replaceWorkingIdentity',gameId,identityHash,feeds.map(feed=>WorkingFeedSchema.parse(feed)));
  }
  removeWorkingGames(gameIds:readonly string[]):void {this.write('removeWorkingGames',gameIds);}
  sourceEventBindings():SourceEventBinding[] {return this.read(z.array(SourceEventBindingSchema),'sourceEventBindings');}
  removeFinalEvidence(gameIds:readonly string[],now:number):void {this.write('removeFinalEvidence',gameIds,now);}
  collectionHistory(now:number):CollectionAttempt[] {return this.read(CollectionHistorySchema,'collectionHistory',[now]);}
  saveListingAttempt(id:string,value:SourceAttempt,observations:{observation:Observation;result:Match}[],bindings:SourceEventBinding[]=[]):void {
    this.write('saveListingAttempt',id,SourceAttemptSchema.parse(value),observations,bindings);
  }
  detailEvidence():DetailEvidence[] {return this.read(z.array(DetailEvidenceSchema),'detailEvidence');}
  saveDetailEvidence(value:DetailEvidence,observation?:{observation:Observation;result:Match}):void {
    this.write('saveDetailEvidence',DetailEvidenceSchema.parse(value),observation??null);
  }
  sportsurgeCatalog():{current:StoredSportsurgeCatalog|null;lastComplete:StoredSportsurgeCatalog|null;previous:StoredSportsurgeCatalog|null} {
    return this.read(SportsurgeHistorySchema,'sportsurgeCatalog');
  }
  saveSportsurgeCatalog(value:StoredSportsurgeCatalog,observations:{observation:Observation;result:Match}[],bindings:SourceEventBinding[]=[]):void {
    this.write('saveSportsurgeCatalog',StoredSportsurgeCatalogSchema.parse(value),observations,bindings);
  }
  streameastCatalog():{current:StoredStreameastCatalog|null;lastComplete:StoredStreameastCatalog|null;previous:StoredStreameastCatalog|null} {
    return this.read(StreameastHistorySchema,'streameastCatalog');
  }
  saveStreameastCatalog(value:StoredStreameastCatalog,observations:{observation:Observation;result:Match}[]):void {
    this.write('saveStreameastCatalog',StoredStreameastCatalogSchema.parse(value),observations);
  }
  membership(season:number):SeasonMembership|undefined {return this.read(SeasonMembershipSchema.nullable(),'membership',[season])??undefined;}
  saveMembership(value:SeasonMembership):void {this.write('saveMembership',SeasonMembershipSchema.parse(value));}
  alias(oldId:string,gameId:string):void {this.write('alias',oldId,gameId);}
  aliases():Record<string,string> {return this.read(z.record(z.string()),'aliases');}
  sweep(now:number):void {this.write('sweep',now);}
  close():void {this.native.close();this.partitionCache.clear();}
}
