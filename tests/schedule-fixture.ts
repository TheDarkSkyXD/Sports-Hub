import {createFixtureSchedule} from '../lib/football/adapters/schedule.ts';
import {SOURCES} from '../lib/football/adapters/sources.ts';
import type {ScheduleSource} from '../lib/football/domain/ports.ts';

export type FixtureSchedule=ReturnType<typeof createFixtureSchedule>;
export function enqueueSchedule(fixture:FixtureSchedule,source:ScheduleSource,now:number,
  response:(url:URL)=>unknown,offsets:readonly number[]=[-1,0,1,2,3,4,5,6,7]):void {
  for(const offset of offsets){
    const date=new Date(now+offset*86400000).toISOString().slice(0,10).replaceAll('-','');
    const url=new URL(`https://site.api.espn.com/apis/site/v2/sports/${source.sport??'football'}/${source.path}/scoreboard`);
    url.searchParams.set('limit','200');url.searchParams.set('dates',date);
    if(source.group)url.searchParams.set('groups',source.group);
    const value=response(url);
    const script=value&&typeof value==='object'&&('body' in value||'status' in value||'failure' in value||'gate' in value||'pending' in value||'chunks' in value||'delayMs' in value)
      ? value : {body:JSON.stringify(value)};
    fixture.enqueueFixture({url:url.href,...script});
  }
}
export function enqueueMembership(fixture:FixtureSchedule,season:number,response:(group:string)=>unknown):void {
  for(const group of ['80','81','35'])fixture.enqueueFixture({url:`https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${season}/types/2/groups/${group}/teams?limit=1000`,body:JSON.stringify(response(group))});
}
export async function waitForSchedule(predicate:()=>boolean):Promise<void> {
  const deadline=Date.now()+5000;
  while(!predicate()&&Date.now()<deadline)await new Promise<void>(resolve=>setTimeout(resolve,1));
  if(!predicate())throw new Error('Native schedule fixture did not reach the expected state');
}
export async function enqueueListings(fixture:FixtureSchedule,reader:(url:string)=>Promise<string>,includePpv=true):Promise<void> {
  for(const source of SOURCES.filter(source=>source.id==='streamed'||source.id==='livesportpro'||includePpv&&source.id==='ppv')){
    try{fixture.enqueueFixture({url:source.url,body:await reader(source.url)});}
    catch(error){fixture.enqueueFixture({url:source.url,failure:{message:error instanceof Error?error.message:'offline'}});}
  }
}
