import { parentPort } from 'node:worker_threads';
import { SCHEDULES, readSchedule, type ScheduleDayCache, type ScheduleListingCache } from '../adapters/schedule.ts';
import { ScheduleQueue } from './schedule-queue.ts';

if (!parentPort) throw new Error('Schedule worker requires a parent port.');
const port=parentPort;
const queue=new ScheduleQueue();

const requests=new Map<number,AbortController>();
const futureCache:ScheduleDayCache=new Map();
const listingCache:ScheduleListingCache={};
const wrestlingListingCaches={wwe:{} as ScheduleListingCache,tna:{} as ScheduleListingCache};
type ReadMessage={kind:'read';id:number;partitionId:string;now:number};
type CancelMessage={kind:'cancel';id:number};
function failure(error:unknown):{code:string;message:string} {
  if(error instanceof DOMException&&error.name==='TimeoutError')return {code:'timeout',message:'Schedule provider timed out.'};
  if(error instanceof TypeError)return {code:'network',message:'Schedule provider network failed.'};
  const message=error instanceof Error?error.message:'schedule-unavailable';
  if(/^http-\d{3}$/.test(message))return {code:'http',message};
  if(message==='source-schedule-unavailable')return {code:'source-unavailable',message};
  if(message.includes('format'))return {code:'format',message};
  if(message.includes('incomplete')||message.includes('truncated'))return {code:'incomplete',message};
  if(message.includes('conflict'))return {code:'conflict',message};
  return {code:'schedule-unavailable',message:'Schedule provider unavailable.'};
}
port.on('message',(input:ReadMessage|CancelMessage)=>{
  if(!input||typeof input!=='object')return;
  if(input.kind==='cancel') {
    requests.get(input.id)?.abort();
    requests.delete(input.id);
    return;
  }
  if(input.kind!=='read'||!Number.isSafeInteger(input.id)||!Number.isFinite(input.now))return;
  const source=SCHEDULES.find(source=>source.id===input.partitionId);
  if(!source){port.postMessage({kind:'failed',id:input.id,failure:{code:'schedule-unavailable',message:'Unknown schedule partition.'}});return;}
  const controller=new AbortController();
  requests.set(input.id,controller);
  void readSchedule(source,input.now,controller.signal,result=>{
    if(requests.has(input.id))port.postMessage({kind:'current',id:input.id,result});
  },queue.run,futureCache,source.league==='wwe'?wrestlingListingCaches.wwe:
    source.league==='tna'?wrestlingListingCaches.tna:listingCache).then(result=>{
    if(requests.has(input.id))port.postMessage({kind:'complete',id:input.id,result});
  },error=>{
    if(requests.has(input.id))port.postMessage({kind:'failed',id:input.id,failure:failure(error)});
  }).finally(()=>{requests.delete(input.id);controller.abort();});
});
