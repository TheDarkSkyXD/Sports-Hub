import {z} from 'zod';
import type {CandidateLocator} from '../../football/shared.ts';

type Locator=Extract<CandidateLocator,{provider:'streamcenter'}>;
const team=z.object({name:z.string().trim().min(1).max(160)});
const match=z.object({id:z.string(),title:z.string().trim().min(1).max(400),category:z.string(),
  date:z.number().int().min(Date.UTC(2000,0,1)).max(Date.UTC(2100,0,1)),
  teams:z.object({home:team,away:team}),sources:z.array(z.object({source:z.string(),id:z.string()})).max(24)});
const stream=z.object({id:z.string().uuid(),streamNo:z.number().int().min(1).max(100),source:z.string(),
  embedUrl:z.string(),webUrl:z.string().optional()});

export function streamcenterIdentity(locator:Locator) {
  if(!/^\d{5,12}$/.test(locator.eventId)||!z.string().uuid().safeParse(locator.linkId).success)
    throw new Error('Unsupported StreamCenter event');
  const sport=locator.league==='nba'||locator.league==='wnba'?'basketball':locator.league==='nhl'?'hockey':
    locator.league==='mlb'?'baseball':'football';
  const league=locator.league==='nba'?'basketball-nba':locator.league==='wnba'?'basketball-wnba':
    locator.league==='nhl'?'hockey-nhl':locator.league==='mlb'?'baseball-mlb':'football-college-football';
  const eventId=`event-espn-league-${league}-${locator.eventId}`;
  return {sport,eventId,catalog:`https://streamcenter.st/api/matches/${sport}`,
    watch:`https://streamcenter.st/watch/${eventId}`,streams:`https://streamcenter.st/api/stream/iframe/${eventId}`};
}

export function selectedStreamcenterGroup(value:unknown,locator:Locator):void {
  const identity=streamcenterIdentity(locator),parsed=z.array(match).max(200).safeParse(value);
  if(!parsed.success)throw new Error('StreamCenter catalog changed');
  const found=parsed.data.filter(row=>row.id===identity.eventId);
  if(found.length!==1||found[0].category!==identity.sport||
    found[0].sources.filter(group=>group.source==='iframe'&&group.id===identity.eventId).length!==1)
    throw new Error('StreamCenter event changed');
}

export function selectedStreamcenterPlayer(value:unknown,locator:Locator):URL {
  const identity=streamcenterIdentity(locator),parsed=z.array(stream).max(24).safeParse(value);
  if(!parsed.success||new Set(parsed.data.map(row=>row.id)).size!==parsed.data.length||
    new Set(parsed.data.map(row=>row.streamNo)).size!==parsed.data.length)
    throw new Error('StreamCenter streams changed');
  const found=parsed.data.filter(row=>row.id===locator.linkId);
  if(found.length!==1||found[0].source!=='iframe'||found[0].webUrl!==identity.watch||
    !/^https:\/\/streame\.center\/embed\/ch\d{1,4}\.php$/.test(found[0].embedUrl))
    throw new Error('StreamCenter selected player changed');
  return new URL(found[0].embedUrl);
}
