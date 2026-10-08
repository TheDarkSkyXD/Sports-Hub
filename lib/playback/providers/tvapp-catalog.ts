import { z } from 'zod';
import { COLLEGE_TEAM_CATALOG } from '../../football/domain/college-teams.generated.ts';

const catalogTeamsSchema=z.object({home:z.object({name:z.string().min(1)}),away:z.object({name:z.string().min(1)})});
export const TvappMatch=z.object({id:z.string().min(1),title:z.string().min(1),
  category:z.enum(['american-football','basketball','hockey']),date:z.number().int(),teams:catalogTeamsSchema.nullish()});
export const TvappSourceRef=z.object({source:z.string().regex(/^[a-z0-9-]{1,32}$/),
  id:z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/)});
export const TvappDetailMatch=TvappMatch.extend({sources:z.array(TvappSourceRef).max(32)});
export const TvappStream=z.object({id:TvappSourceRef.shape.id,source:TvappSourceRef.shape.source,
  streamNo:z.number().int().min(1).max(100),language:z.string().min(1),hd:z.boolean(),embedUrl:z.string().url()});

const collegeOwnerByAlias=new Map<string,string|null>();
const exactAlias=(name:string)=>name.toLowerCase().replace(/\s+/g,' ').trim();
for(const team of COLLEGE_TEAM_CATALOG)for(const alias of team.aliases){
  const name=exactAlias(alias);
  const prior=collegeOwnerByAlias.get(name);
  if(prior===undefined)collegeOwnerByAlias.set(name,team.id);
  else if(prior!==team.id)collegeOwnerByAlias.set(name,null);
}

function sameUniqueCollegeOwner(left:string,right:string):boolean {
  const owner=collegeOwnerByAlias.get(exactAlias(left));
  return owner!==undefined&&owner!==null&&owner===collegeOwnerByAlias.get(exactAlias(right));
}

export function catalogTeams(title:string):[string,string]|null {
  const parts=title.split(/\s+(?:vs\.?|at|-)\s+/i).map(value=>value.trim());
  return parts.length===2&&parts.every(Boolean)?[parts[0],parts[1]]:null;
}

export function preferredCatalogTeams(title:string,structured:[string,string]|null):[string,string]|null {
  const titled=catalogTeams(title);
  if(!structured||!titled)return titled||structured;
  const related=(left:string,right:string)=>{
    const a=left.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const b=right.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    return a.includes(b)||b.includes(a)||sameUniqueCollegeOwner(left,right);
  };
  const aligned=related(titled[0],structured[0])&&related(titled[1],structured[1])||
    related(titled[0],structured[1])&&related(titled[1],structured[0]);
  if(!aligned)return null;
  return titled.join('').length>structured.join('').length?titled:structured;
}

export function tvappIdentity(value:unknown):{
  watchUrl:string;title:string;teams:[string,string];kickoff:number;
  sources:z.infer<typeof TvappSourceRef>[];
}|null {
  const parsed=TvappDetailMatch.safeParse(value);
  if(!parsed.success)return null;
  const event=parsed.data;
  if(event.date<Date.UTC(2000,0,1)||event.date>=Date.UTC(2100,0,1))return null;
  const title=event.title.replace(/\s+/g,' ').trim();
  const structured:[string,string]|null=event.teams?
    [event.teams.home.name.trim(),event.teams.away.name.trim()]:null;
  const teams=preferredCatalogTeams(title,structured);
  if(!teams)return null;
  const slug=event.id.startsWith('ppv-')||/^\d+$/.test(event.id)?event.id:/-(\d+)$/.exec(event.id)?.[1];
  if(!slug||! /^[a-zA-Z0-9-]{1,120}$/.test(slug))return null;
  return {watchUrl:`https://tvapp1.pk/watch/${slug}`,title,teams,kickoff:event.date,sources:event.sources};
}

export function tvappStreams(value:unknown,source:string,sourceId:string):z.infer<typeof TvappStream>[]|null {
  if(!Array.isArray(value)||value.length>100)return null;
  const rows=[];
  const seen=new Set<number>();
  for(const item of value){
    const parsed=TvappStream.safeParse(item);
    if(!parsed.success)return null;
    const row=parsed.data;
    if(row.source!==source||row.id!==sourceId||
      row.embedUrl!==`https://embed.st/embed/${source}/${sourceId}/${row.streamNo}`||
      seen.has(row.streamNo))return null;
    seen.add(row.streamNo);
    rows.push(row);
  }
  return rows;
}
