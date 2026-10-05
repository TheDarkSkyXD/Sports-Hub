import {z} from 'zod';

const tenant='Southwestern-Athletic-Conference';
const category='e1dbe7ec9a7e686b42b53ab33c3e30e4';
const api='https://ott.gideo.video/api/legacy';
const eventIdPattern=/^[a-f0-9]{32}$/;
export const SWAC_CATALOG_URL=`${api}?cmd=getCategoryChildren&AccountID=${tenant}&CategoryID=${category}`;
export const SwacEventSchema=z.object({
  id:z.string().regex(eventIdPattern),title:z.string(),type:z.literal('video'),live:z.boolean(),
  freeBehavior:z.string(),description:z.string(),goLiveTime:z.string().optional(),
});
export type SwacEvent=z.infer<typeof SwacEventSchema>;
const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
const central=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'});

export function swacProgramUrl(id:string):string {
  return `https://tv.swac.org/program-group/${category}/program/${id}`;
}

export function swacProgramId(value:string):string|null {
  try {
    const address=new URL(value),id=address.pathname.split('/').at(-1);
    return id && eventIdPattern.test(id) && value===swacProgramUrl(id) ? id : null;
  } catch {return null;}
}

export function swacApiUrl(command:'getVideo'|'getVideoUrls',id:string):string {
  if(!eventIdPattern.test(id))throw new Error('Unsupported SWAC event');
  return command==='getVideoUrls' ? `${api}?cmd=${command}&accountId=${tenant}&videoId=${id}` : `${api}?cmd=${command}&AccountID=${tenant}&VideoID=${id}`;
}

export function parseSwacEvent(input:unknown):{event:SwacEvent;teams:[string,string];kickoff:number}|null {
  const parsed=SwacEventSchema.safeParse(input);
  if(!parsed.success)return null;
  const event=parsed.data;
  if(!event.live || !['allow','allow_ads'].includes(event.freeBehavior))return null;
  const title=/^Football \((\d{1,2})\/(\d{1,2})\/(\d{2})\) (.+?) vs (.+?)\s*$/.exec(event.title);
  const time=/^([A-Za-z]+)\s+(\d{1,2}),\s+(20\d{2})\s*\|\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+CT\b/.exec(event.description.trim());
  if(!title || !time)return null;
  const month=months.indexOf(time[1])+1,day=Number(time[2]),year=Number(time[3]),hour=Number(time[4]),minute=Number(time[5]);
  if(month!==Number(title[1]) || day!==Number(title[2]) || year!==2000+Number(title[3]) || hour<1 || hour>12 || minute>59)return null;
  const hour24=hour%12+(time[6]==='PM'?12:0);
  const naive=Date.UTC(year,month-1,day,hour24,minute);
  const matches=[5,6].map(offset=>naive+offset*3600000).filter(value=>{
    const parts=Object.fromEntries(central.formatToParts(value).map(part=>[part.type,part.value]));
    return Number(parts.year)===year && Number(parts.month)===month && Number(parts.day)===day && Number(parts.hour)===hour24 && Number(parts.minute)===minute;
  });
  if(matches.length!==1)return null;
  const kickoff=matches[0],preroll=Date.parse(event.goLiveTime || '');
  if(!Number.isFinite(preroll) || preroll>kickoff || kickoff-preroll>3600000)return null;
  return {event,teams:[title[4].trim(),title[5].trim()],kickoff};
}
