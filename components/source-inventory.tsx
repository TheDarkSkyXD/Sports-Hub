'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, Clock3, LoaderCircle, RefreshCw } from 'lucide-react';
import Image from 'next/image';
import { SourcesSnapshotSchema, type CandidateSummary, type Game, type LinkEvidence, type MissingPlayerReason, type SourcesSnapshot, type SportsurgeCatalogView, type StreameastCatalogView } from '@/lib/football/shared';
import { retainedStreameastDetail } from './source-inventory-view';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const sourceOrder=new Map([['sportsurge',0],['sportsurge-v2',1],['streameast',2]]);
type Source = SourcesSnapshot['sources'][number];
type InventoryLeague=Game['league'];
type SourceStatus = 'integration-pending'|'waiting'|'collector-unavailable'|'collecting'|'complete'|'partial'|'interrupted'|'unrecorded'|'league-collected'|'league-failed'|NonNullable<Source['lastAttempt']>['outcome'];
type SourceFilter = 'all'|'attention'|'checked'|'listings';
type BadgeTone = 'neutral'|'warning'|'fetched'|'complete'|'progress';
type ScopeFilters={sourceQuery:string;sourceFilter:SourceFilter;gameQuery:string;gameLimit:number};
const GAME_PAGE_SIZE=20;
const defaultScopeFilters=():ScopeFilters=>({sourceQuery:'',sourceFilter:'all',gameQuery:'',gameLimit:GAME_PAGE_SIZE});
const nflOnly=new Set(['nflstreams']);
const collegeOnly=new Set(['swac','streamcenter']);
const leagueName:Record<InventoryLeague,string>={nfl:'NFL',ncaaf:'NCAA CFB'};
const sourceInLeague=(id:string,league:InventoryLeague)=>league==='nfl'?
  !collegeOnly.has(id)&&!/(?:-cfb|-ncaaf)$/.test(id):!nflOnly.has(id)&&!/-nfl$/.test(id);
const statusMeta:Record<SourceStatus,{label:string;attention:boolean}>={
  'integration-pending':{label:'Integration pending',attention:false},
  waiting:{label:'Waiting for collection',attention:false},
  'collector-unavailable':{label:'Collector unavailable',attention:true},
  collecting:{label:'Collecting',attention:false},
  complete:{label:'Collection complete',attention:false},
  'league-collected':{label:'League collected',attention:false},
  'league-failed':{label:'League collection failed',attention:true},
  partial:{label:'Partial collection',attention:true},
  interrupted:{label:'Interrupted',attention:true},
  unrecorded:{label:'Not fetched yet',attention:false},
  parsed:{label:'Fetched',attention:false},
  empty:{label:'No listings',attention:false},
  unsupported:{label:'Unsupported page',attention:true},
  'parser-changed':{label:'Parser changed',attention:true},
  failed:{label:'Fetch failed',attention:true},
};
function sourceStatus(source:Source,snapshot:SourcesSnapshot,league:InventoryLeague):SourceStatus {
  if(source.pending)return 'integration-pending';
  const run=source.id==='sportsurge-v2'?snapshot.sportsurgeV2.current:source.id==='streameast'?snapshot.streameast.current:null;
  if(source.id==='sportsurge-v2'||source.id==='streameast') {
    if(!snapshot.browserCollectorsAvailable)return 'collector-unavailable';
    if(!run)return 'waiting';
    const category=run.categories[league];
    if(category.kind==='failed')return 'league-failed';
    if(category.kind==='pending')return run.interrupted?'interrupted':run.state.kind==='collecting'?'collecting':'waiting';
    const games=run.games.filter(game=>game.league===league);
    const rejected=run.rejectedGames.some(game=>game.league===league)||
      (source.id==='sportsurge-v2'&&snapshot.sportsurgeV2.current?.catalogIssues.some(issue=>issue.league===league));
    if(rejected||games.some(game=>game.detail.kind==='failed'))return 'partial';
    if(games.some(game=>game.detail.kind==='pending'))return run.interrupted?'interrupted':
      run.state.kind==='collecting'?'collecting':'partial';
    return 'league-collected';
  }
  return source.lastAttempt?.outcome??'unrecorded';
}

function badgeTone(status:SourceStatus):BadgeTone {
  if(status==='parsed')return 'fetched';
  if(status==='complete'||status==='league-collected')return 'complete';
  if(status==='collecting')return 'progress';
  return statusMeta[status].attention?'warning':'neutral';
}

function StatusBadge({status}:{status:SourceStatus}) {
  const tone=badgeTone(status);
  const Icon=tone==='fetched'||tone==='complete'?CheckCircle2:tone==='warning'?AlertTriangle:
    tone==='progress'?LoaderCircle:status==='waiting'?Clock3:CircleHelp;
  return <span className={`source-inventory-badge source-settings-badge source-settings-badge-${tone}`}>
    <Icon size={13} aria-hidden="true" />{statusMeta[status].label}
  </span>;
}

const attemptLabel:Record<NonNullable<SourcesSnapshot['sources'][number]['lastAttempt']>['outcome'],string>={
  parsed:'Fetched',empty:'No listings',unsupported:'Unsupported page','parser-changed':'Parser changed',failed:'Last fetch failed',
};
const failureLabel:Record<NonNullable<NonNullable<SourcesSnapshot['sources'][number]['lastAttempt']>['failure']>,string>={
  'not-found':'Page not found',blocked:'Source blocked','rate-limited':'Rate limited','timed-out':'Timed out',
  'network-unavailable':'Network unavailable','unsupported-address':'Unsupported address',
  'invalid-response':'Invalid response','upstream-error':'Upstream error',
};
const matchReasonLabel:Record<SourcesSnapshot['sources'][number]['unmatchedReasons'][number]['reason'],string>={
  'not-a-matchup':'No clear matchup','unknown-teams':'Teams not recognized','unverified-kickoff':'Kickoff not verified',
  'unverified-contextual-kickoff':'Matchup date needs verification',
  'ambiguous-matchup':'Ambiguous matchup','conflicting-date':'Conflicting kickoff','finished-game':'Game finished',other:'Other matching reason',
};
const time=(value:number)=>new Date(value).toLocaleString();
const age=(value:number,now:number)=>{
  const minutes=Math.max(0,Math.floor((now-value)/60_000));
  return `${minutes} ${minutes>1?'mins':'min'} ago`;
};
const duration=(milliseconds:number)=>{
  const seconds=Math.max(0,Math.floor(milliseconds/1000));
  return seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`;
};
const countLabel=(value:number,incomplete:boolean)=>incomplete?value===0?'—':`${value}+`:String(value);
const publicLinkLabel=(value:string)=>{const url=new URL(value);return `${url.hostname}${url.pathname}${url.hash}`;};
type BrandedGame=Pick<Game,'id'|'home'|'away'> & {league?:Game['league']};
type ScopedSource={source:Source;matchedGames:number;workingChoices:number;
  links:Source['links'];unclassifiedLinks:Source['links'];incomplete:boolean};
function scopeInventory(snapshot:SourcesSnapshot,branding:readonly BrandedGame[],league:InventoryLeague){
  const knownLeague=new Map(branding.map(game=>[game.id,game.league]));
  const games=snapshot.games.filter(game=>knownLeague.get(game.gameId)===league);
  const unclassifiedGames=snapshot.games.filter(game=>knownLeague.get(game.gameId)===undefined);
  const sources:ScopedSource[]=snapshot.sources.filter(source=>sourceInLeague(source.id,league)).map(source=>{
    const linkedGames=games.filter(game=>game.sourceLinks.some(link=>link.sourceId===source.id));
    const candidates=games.flatMap(game=>game.candidates.filter(candidate=>candidate.sourceIds.includes(source.id)));
    return {source,matchedGames:linkedGames.length,
      workingChoices:candidates.filter(candidate=>candidate.availability.kind==='playable').length,
      links:source.links.filter(link=>link.gameId!==null&&knownLeague.get(link.gameId)===league),
      unclassifiedLinks:source.links.filter(link=>link.gameId===null||knownLeague.get(link.gameId)===undefined),
      incomplete:unclassifiedGames.some(game=>game.sourceLinks.some(link=>link.sourceId===source.id)||
        game.candidates.some(candidate=>candidate.sourceIds.includes(source.id)))};
  });
  return {games,unclassifiedGames,sources,
    workingChoices:games.reduce((total,game)=>total+game.workingChoiceCount,0)};
}
const sourceIcons:Record<string,string>={
  sportsurge:'/source-icons/sportsurge.png',
  'crackstreams-cfb':'/source-icons/crackstreams.ico',
  'crackstreams-nfl':'/source-icons/crackstreams.ico',
  'buffstream-cfb':'/source-icons/buffstream.ico',
  'buffstream-nfl':'/source-icons/buffstream.ico',
  'vipbox-cfb':'/source-icons/vipbox.ico',
  'vipbox-nfl':'/source-icons/vipbox.ico',
  streameast:'/source-icons/streameast.ico',
  tvapp:'/source-icons/tvapp.png',
  ppv:'/source-icons/ppv.ico',
};
function LogoMark({src,fallback}:{src:string|undefined;fallback:string}) {
  const [failed,setFailed]=useState(false);
  return <span className="source-inventory-logo" aria-hidden="true">
    {src&&!failed?<Image src={src} alt="" width={22} height={22} unoptimized onError={()=>setFailed(true)}/>:
      <span className="source-inventory-logo-fallback">{fallback}</span>}
  </span>;
}
function safeTeamLogo(src:string|undefined) {
  return src?.startsWith('https://')||src?.startsWith('/')&&!src.startsWith('//')?src:undefined;
}
function GameTitle({name,game}:{name:string;game:BrandedGame|undefined}) {
  return <span className="source-inventory-title-row">
    {game&&<span className="source-inventory-team-logos">
      <LogoMark key={`${game.id}:away:${game.away.logo}`} src={safeTeamLogo(game.away.logo)} fallback={game.away.abbreviation}/>
      <LogoMark key={`${game.id}:home:${game.home.logo}`} src={safeTeamLogo(game.home.logo)} fallback={game.home.abbreviation}/>
    </span>}
    <strong>{name}</strong>
  </span>;
}
const catalogFailureLabel:Record<Extract<SportsurgeCatalogView['state'],{kind:'partial'}>['reason'],string>={
  blocked:'Source blocked','rate-limited':'Rate limited; collection paused',timeout:'Timed out',
  'parser-changed':'Page format changed',unavailable:'Source unavailable','invalid-detail-url':'Invalid game link',limit:'Collection limit reached',
};
const categoryLabel=(value:SportsurgeCatalogView['categories']['ncaaf'])=>value.kind==='collected'?'collected':value.kind==='pending'?'pending':`failed (${catalogFailureLabel[value.reason]})`;
const candidateEvidence=(candidate:CandidateSummary,now:number)=>{
  switch(candidate.availability.kind) {
    case 'unknown':return 'Media not checked yet';
    case 'checking':{
      const progress=candidate.availability.progress;
      switch(progress.kind) {
        case 'queued':return `Queued for media check · Waiting ${duration(now-progress.since)}`;
        case 'active':return `Checking media · ${duration(now-progress.since)} elapsed`;
        case 'deferred':return `Waiting to retry · ${duration(progress.retryAt-now)} remaining`;
        default:{const exhaustive:never=progress;return exhaustive;}
      }
    }
    case 'playable':return candidate.availability.proof==='decoded'?'Working · Playback decoded':'Working · Media checked';
    case 'unavailable':return {
      upstream:'Source media unavailable',unsupported:'Player unsupported',
      'invalid-media':'No valid video returned',timeout:'Media check timed out',playback:'Playback failed',
    }[candidate.availability.reason];
    default:{const exhaustive:never=candidate.availability;return exhaustive;}
  }
};

const missingReasonLabel:Record<MissingPlayerReason,string>={
  'no-compatible-media':'No supported feed found',
  'not-yet-published':'Player not yet published',
  'no-published-player':'No feeds published by source',
  'unsupported-player':'Published player is unsupported',
  'paid-only':'Only paid players published',
  'conflicting-game':'Game details conflict',
  'parser-changed':'Player page format changed',
};

function ListingEvidence({evidence,at,candidates}:{evidence:LinkEvidence;at:number;candidates:CandidateSummary[]}) {
  switch(evidence.kind) {
    case 'pending':return <span className="source-inventory-evidence" data-state="pending">Player collection queued</span>;
    case 'unmatched':return <span className="source-inventory-evidence" data-state="warning">{matchReasonLabel[evidence.reason]}</span>;
    case 'collected':{
      const available=new Set(evidence.candidateIds.filter(id=>candidates.some(candidate=>candidate.id===id&&candidate.availability.kind==='playable'))).size;
      return <span className="source-inventory-evidence" data-state="collected">{available} available {available===1?'feed':'feeds'} · Collected {time(evidence.checkedAt)} · {age(evidence.checkedAt,at)}</span>;
    }
    case 'missing':return <span className="source-inventory-evidence" data-state={evidence.reason==='not-yet-published'?'pending':'warning'}>
      {missingReasonLabel[evidence.reason]} · Checked {time(evidence.checkedAt)} · {age(evidence.checkedAt,at)}{evidence.retryAt===null?'':` · Retry eligible ${time(evidence.retryAt)}`}</span>;
    case 'failed':return <span className="source-inventory-evidence" data-state="warning">Player collection failed · {failureLabel[evidence.failure]} · Checked {time(evidence.checkedAt)} · {age(evidence.checkedAt,at)}{evidence.retryAt===null?'':` · Retry eligible ${time(evidence.retryAt)}`}</span>;
    default:{const exhaustive:never=evidence;return exhaustive;}
  }
}

function SourceGameCard({title,summary,children}:{title:ReactNode;summary:string;children:ReactNode}) {
  return <details className="source-inventory-item source-inventory-game-card">
    <summary><strong>{title}</strong><span>{summary}</span></summary>
    {children}
  </details>;
}

function SourceFeedChecks({candidates,at,now}:{candidates:CandidateSummary[];at:number;now:number}) {
  if(!candidates.length)return null;
  return <div className="source-inventory-candidates"><strong>Feed check results</strong><ul>
    {candidates.map(candidate=><li key={candidate.id}><span>{candidate.label}</span>
      <span className="source-inventory-check" data-state={candidate.availability.kind}>{candidateEvidence(candidate,now)}
        {candidate.availability.kind==='playable'||candidate.availability.kind==='unavailable'?` · Checked ${time(candidate.availability.checkedAt)} · ${age(candidate.availability.checkedAt,at)}`:''}
      </span></li>)}
  </ul></div>;
}

function SourceLinks({source,links,snapshot,now}:{source:Source;links:Source['links'];snapshot:SourcesSnapshot;now:number}) {
  const groups=new Map<string,Source['links']>();
  for(const link of links){
    const key=link.gameId??link.url;
    groups.set(key,[...(groups.get(key)??[]),link]);
  }
  if(!groups.size)return null;
  return <div className="source-inventory-list source-inventory-source-games">{[...groups].map(([key,gameLinks])=>{
    const game=snapshot.games.find(row=>row.gameId===gameLinks[0].gameId);
    const candidates=game?.candidates.filter(candidate=>candidate.sourceIds.includes(source.id))??[];
    const available=candidates.filter(candidate=>candidate.availability.kind==='playable').length;
    return <SourceGameCard key={key} title={game?.name??gameLinks[0].title}
      summary={`${available} available ${available===1?'feed':'feeds'} · ${gameLinks.length} ${gameLinks.length===1?'listing':'listings'}`}>
      <SourceFeedChecks candidates={candidates} at={snapshot.at} now={now}/>
      <ul>{gameLinks.map(link=><li key={link.url}>{source.id==='sportsurge-v2'?<span>{link.title}</span>:<a href={link.url} target="_blank" rel="noopener noreferrer">{link.title} ↗</a>}
        {link.freshness==='stale-live'&&<span>Last seen {time(link.observedAt)}</span>}
        <ListingEvidence evidence={link.evidence} at={snapshot.at} candidates={candidates}/></li>)}</ul>
    </SourceGameCard>;
  })}</div>;
}

function RetainedCatalogLinks({source,links,snapshot,league,now}:{source:Source;links:Source['links'];
  snapshot:SourcesSnapshot;league:InventoryLeague;now:number}) {
  const runs=source.id==='sportsurge-v2'?snapshot.sportsurgeV2:snapshot.streameast;
  const currentKeys=new Set(runs.current?.games.filter(game=>game.league===league).map(catalogGameKey)??[]);
  const retained=links.filter(link=>!currentKeys.has(link.gameId??link.url));
  if(!retained.length)return null;
  return <div className="source-inventory-catalog"><p>Retained {leagueName[league]} game links</p>
    <SourceLinks source={source} links={retained} snapshot={snapshot} now={now}/></div>;
}

function CollectionHealth({source}:{source:Source}) {
  const health=source.collectionHealth;
  if(health.kind!=='attention')return null;
  const reason={
    'parser-changed':'The source page format changed.',
    'empty-after-success':'This collection returned no listings after an earlier successful collection.',
    'player-drop':'A game page stopped publishing supported free players.',
    'collection-failed':health.currentCount>0?'The latest collection failed after collecting some listings. Previously saved listings are retained below.':
      source.links.length>0?'The latest collection failed. Previously saved listings are retained below.':'The latest collection failed; no new listing count was confirmed.',
  }[health.reason];
  return <div className="source-inventory-coverage-alert" role="note"><AlertTriangle size={16} aria-hidden="true"/>
    <div><strong>Source collection needs attention</strong><p>{reason}</p>
      {health.reason==='collection-failed'?<p>Last successful scan {time(health.baselineAt)}. Latest attempt failed {time(health.currentAt)}; {health.currentCount>0?`${health.currentCount} ${health.currentCount===1?'listing was':'listings were'} collected`:'no new listing count was confirmed'}.</p>:
        <p>{health.reason==='player-drop'?'Feeds found':health.reason==='parser-changed'?'Collected results':'Listings'}: {health.baselineCount} at {time(health.baselineAt)} → {health.currentCount} at {time(health.currentAt)}. Source availability may have changed.</p>}</div>
  </div>;
}

function catalogGameKey(game:{gameId:string|null;url:string}) {
  return game.gameId??game.url;
}

function catalogGameGroups<T extends {gameId:string|null;url:string}>(games:T[]) {
  const groups=new Map<string,T[]>();
  for(const game of games){
    const key=catalogGameKey(game);
    groups.set(key,[...(groups.get(key)??[]),game]);
  }
  return groups;
}

function SportsurgeRun({run,league,snapshot,now,isCurrent,links}:{run:SportsurgeCatalogView;league:InventoryLeague;
  snapshot:SourcesSnapshot;now:number;isCurrent:boolean;links:Source['links']}) {
  const games=run.games.filter(game=>game.league===league);
  const groupedGames=catalogGameGroups(games);
  const rejectedGames=run.rejectedGames.filter(game=>game.league===league);
  const catalogIssues=run.catalogIssues.filter(issue=>issue.league===league);
  const details=games.filter(game=>game.detail.kind==='collected');
  return <div className="source-inventory-catalog">
    <p>{leagueName[league]} listings {categoryLabel(run.categories[league])} · Shared checkpoint {time(run.receivedAt)}</p>
    <p>{games.length} game listings · {details.length} details collected · {games.filter(game=>game.detail.kind==='pending').length} pending · {games.filter(game=>game.detail.kind==='failed').length} failed</p>
    <p>{games.reduce((count,game)=>count+(game.detail.kind==='collected'?game.detail.providers.length:0),0)} provider rows · {rejectedGames.length} rejected game links · {catalogIssues.length} duplicate-ID notices</p>
    {rejectedGames.length>0&&<details className="source-inventory-diagnostics"><summary>Rejected game links</summary><ul>
      {rejectedGames.map((game,index)=><li key={`${game.league}:${index}`}>{game.title || `${game.league.toUpperCase()} listing`}: {game.reason}</li>)}
    </ul></details>}
    {catalogIssues.length>0&&<details className="source-inventory-diagnostics"><summary>Catalog identity notices</summary><ul>
      {catalogIssues.map((issue,index)=><li key={`${issue.league}:${index}`}>{issue.title}: {issue.reason}</li>)}
    </ul></details>}
    {groupedGames.size>0&&<div className="source-inventory-list source-inventory-source-games">{[...groupedGames].map(([key,listings])=>{
      const game=listings[0];
      const candidates=isCurrent&&game.gameId?snapshot.games.find(row=>row.gameId===game.gameId)?.candidates.filter(candidate=>candidate.sourceIds.includes('sportsurge-v2'))??[]:[];
      const available=candidates.filter(candidate=>candidate.availability.kind==='playable').length;
      const providerRows=listings.reduce((count,listing)=>count+(listing.detail.kind==='collected'?listing.detail.providers.length:0),0);
      return <SourceGameCard key={key} title={game.title} summary={isCurrent?
        `${available} available ${available===1?'feed':'feeds'} · ${providerRows} provider rows`:`Saved scan · ${providerRows} provider rows`}>
        <SourceFeedChecks candidates={candidates} at={snapshot.at} now={now}/>
        {isCurrent&&links.filter(link=>link.freshness==='stale-live'&&catalogGameKey(link)===key).map(link=><p key={link.url}>Retained listing: {link.title} · Last seen {time(link.observedAt)}</p>)}
        {listings.map(listing=><div key={listing.url} className="source-inventory-listing">
          <p>{listing.gameId?'Matched to ESPN':matchReasonLabel[listing.matchReason || 'other']} · {listing.detail.kind==='collected'?`${listing.detail.providers.length} provider rows`:listing.detail.kind==='failed'?`Detail failed (${catalogFailureLabel[listing.detail.reason]})`:'Detail pending'}</p>
          {listing.detail.kind==='collected'&&<ul>{listing.detail.providers.map(provider=><li key={provider.id}>
            {provider.destination.kind==='link'?<span>{provider.label} · Listed for the custom player</span>:
              <span>{provider.label} · {provider.destination.kind==='malformed'?'Malformed':'Rejected'} ({provider.destination.reason}){provider.destination.kind==='rejected'&&provider.destination.display?` · ${provider.destination.display}`:''}</span>}
          </li>)}</ul>}
        </div>)}
      </SourceGameCard>;
    })}</div>}
  </div>;
}

function StreameastRun({run,league,snapshot,now,isCurrent,links}:{run:StreameastCatalogView;league:InventoryLeague;
  snapshot:SourcesSnapshot;now:number;isCurrent:boolean;links:Source['links']}) {
  const games=run.games.filter(game=>game.league===league);
  const groupedGames=catalogGameGroups(games);
  const savedGames=isCurrent?[...(snapshot.streameast.previous?.games??[]),...(snapshot.streameast.lastComplete?.games??[])]:[];
  const rejectedGames=run.rejectedGames.filter(game=>game.league===league);
  const details=games.filter(game=>game.detail.kind==='collected');
  const servers=games.flatMap(game=>game.detail.kind==='collected'?game.detail.servers:[]);
  return <div className="source-inventory-catalog">
    <p>{leagueName[league]} listings {categoryLabel(run.categories[league])} · Shared checkpoint {time(run.receivedAt)}</p>
    <p>{games.length} game listings · {details.length} details collected · {games.filter(game=>game.detail.kind==='pending').length} pending · {games.filter(game=>game.detail.kind==='failed').length} failed</p>
    <p>{servers.length} server rows · {servers.filter(server=>server.availability.kind.startsWith('free-')).length} marked free · {servers.filter(server=>server.availability.kind==='premium').length} premium</p>
    {rejectedGames.length>0&&<details className="source-inventory-diagnostics"><summary>Rejected game links · {rejectedGames.length}</summary><ul>
      {rejectedGames.map((game,index)=><li key={`${game.league}:${index}`}>{game.title}: {game.reason}</li>)}
    </ul></details>}
    {groupedGames.size>0&&<div className="source-inventory-list source-inventory-source-games">{[...groupedGames].map(([key,listings])=>{
      const game=listings[0];
      const candidates=isCurrent&&game.gameId?snapshot.games.find(row=>row.gameId===game.gameId)?.candidates.filter(candidate=>candidate.sourceIds.includes('streameast'))??[]:[];
      const available=candidates.filter(candidate=>candidate.availability.kind==='playable').length;
      const serverRows=listings.reduce((count,listing)=>count+(listing.detail.kind==='collected'?listing.detail.servers.length:0),0);
      const savedDetails=listings.map(listing=>retainedStreameastDetail(listing,savedGames));
      const savedRows=savedDetails.reduce((count,detail)=>count+(detail?.servers.length??0),0);
      return <SourceGameCard key={key} title={game.title} summary={isCurrent?
        `${available} available ${available===1?'feed':'feeds'} · ${serverRows} current server rows${savedRows?` · ${savedRows} saved server rows`:''}`:`Saved scan · ${serverRows} server rows`}>
        <SourceFeedChecks candidates={candidates} at={snapshot.at} now={now}/>
        {isCurrent&&links.filter(link=>link.freshness==='stale-live'&&catalogGameKey(link)===key).map(link=><p key={link.url}>Retained listing: {link.title} · Last seen {time(link.observedAt)}</p>)}
        {listings.map((listing,index)=>{
          const saved=savedDetails[index];
          const shown=listing.detail.kind==='collected'?listing.detail:saved;
          return <div key={listing.url} className="source-inventory-listing">
          <p><a href={listing.url} target="_blank" rel="noopener noreferrer">Game listing ↗</a> · {listing.gameId?'Matched to ESPN':matchReasonLabel[listing.matchReason || 'other']} · {listing.detail.kind==='collected'?`${listing.detail.servers.length} server rows`:listing.detail.kind==='failed'?`Detail failed (${catalogFailureLabel[listing.detail.reason]})`:'Detail pending'}</p>
          {saved&&<p>Saved server rows · last collected {time(saved.at)} · {saved.servers.length} rows</p>}
          {shown&&<ul>{shown.servers.map(server=><li key={server.id}>
            <a href={server.url} target="_blank" rel="noopener noreferrer">{server.label} ↗</a> · {server.availability.kind==='free-channel'?'Free compatible channel':
              server.availability.kind==='free-wikisport'?'Free compatible Wikisport player':
              server.availability.kind==='free-page'?'Free compatible page':
              server.availability.kind==='free-unsupported'?'Free · unsupported player':server.availability.kind==='free-unresolved'?'Free · player unresolved':
                server.availability.kind==='premium'?'Premium':'Access unresolved'}
          </li>)}</ul>}
        </div>;})}
      </SourceGameCard>;
    })}</div>}
  </div>;
}

function CollectorHistory({source,snapshot,league,now}:{source:Source;snapshot:SourcesSnapshot;league:InventoryLeague;now:number}) {
  const isSportsurge=source.id==='sportsurge-v2';
  const runs=isSportsurge?snapshot.sportsurgeV2:snapshot.streameast;
  const current=runs.current;
  const lastComplete=runs.lastComplete?.runId===current?.runId?null:runs.lastComplete;
  const previous=runs.previous?.runId===current?.runId||runs.previous?.runId===lastComplete?.runId?null:runs.previous;
  const renderRun=(slot:'current'|'previous')=>isSportsurge?
    snapshot.sportsurgeV2[slot]&&<SportsurgeRun run={snapshot.sportsurgeV2[slot]} league={league} snapshot={snapshot} now={now}
      isCurrent={slot==='current'} links={source.links}/>:snapshot.streameast[slot]&&
      <StreameastRun run={snapshot.streameast[slot]} league={league} snapshot={snapshot} now={now}
        isCurrent={slot==='current'} links={source.links}/>;
  return <div className="source-settings-history">
    {!snapshot.browserCollectorsAvailable&&<div className="source-settings-unavailable" role="note">
      <AlertTriangle size={17} aria-hidden="true" />
      <div><strong>Browser collector unavailable</strong><p>This environment cannot collect new listings right now. Saved scans below show earlier collection, not a live collector status.</p></div>
    </div>}
    <div className="source-settings-history-grid">
      <div className="source-settings-history-section">
        <h4>Latest {leagueName[league]} collection</h4>
        {current?<><p>Checkpoint {time(current.receivedAt)} · {age(current.receivedAt,snapshot.at)}</p>{renderRun('current')}</>:
          <p>No collection checkpoint recorded yet.</p>}
      </div>
    </div>
    {previous&&<details className="source-settings-history-details source-settings-previous">
      <summary>Previous partial or interrupted scan · {time(previous.receivedAt)}</summary>{renderRun('previous')}
    </details>}
  </div>;
}

export function SourceInventory({gameIds,branding}:{gameIds:string[];branding?:{games:readonly BrandedGame[]}}) {
  const [snapshot,setSnapshot]=useState<SourcesSnapshot|null>(null);
  const [view,setView]=useState<'sources'|'games'>('sources');
  const [selectedLeague,setSelectedLeague]=useState<InventoryLeague|null>(null);
  const league=selectedLeague??branding?.games.find(game=>gameIds.includes(game.id))?.league??'nfl';
  const [filters,setFilters]=useState<Record<InventoryLeague,ScopeFilters>>(()=>({nfl:defaultScopeFilters(),ncaaf:defaultScopeFilters()}));
  const {sourceQuery,sourceFilter,gameQuery,gameLimit}=filters[league];
  const updateFilters=(change:Partial<ScopeFilters>)=>setFilters(current=>({...current,[league]:{...current[league],...change}}));
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const [retryState,setRetryState]=useState<'idle'|'submitting'|'success'|'error'>('idle');
  const [renderNow,setRenderNow]=useState(()=>Date.now());
  const collecting=snapshot?.sportsurgeV2.current?.state.kind==='collecting'||snapshot?.streameast.current?.state.kind==='collecting';
  const selectedGameIds=[...new Set(gameIds)].slice(0,4);
  const selectedGames=new Set(gameIds);
  const brandedGames=new Map(branding?.games.map(game=>[game.id,game]));
  const scoped=snapshot?scopeInventory(snapshot,branding?.games??[],league):null;
  const sources=[...(scoped?.sources??[])].sort((left,right)=>(sourceOrder.get(left.source.id)??3)-(sourceOrder.get(right.source.id)??3));
  const visibleSources=sources.filter(({source,workingChoices})=>{
    if(!snapshot)return false;
    if(!source.name.toLowerCase().includes(sourceQuery.trim().toLowerCase()))return false;
    const status=sourceStatus(source,snapshot,league);
    if(sourceFilter==='attention')return statusMeta[status].attention||
      (source.id!=='sportsurge-v2'&&source.id!=='streameast'&&source.collectionHealth.kind==='attention');
    if(sourceFilter==='checked')return workingChoices>0;
    if(sourceFilter==='listings')return source.collectionMode==='listings-only';
    return true;
  });
  const pendingEvidence=snapshot?.sources.some(source=>source.links.some(link=>link.evidence.kind==='pending'));
  const pendingChecks=snapshot?.games.some(game=>game.candidates.some(candidate=>candidate.availability.kind==='unknown'||candidate.availability.kind==='checking'));
  const timedChecks=snapshot?.games.some(game=>game.candidates.some(candidate=>candidate.availability.kind==='checking'));
  const query=gameQuery.trim().toLowerCase();
  const listedGames=scoped?.games.filter(game=>game.name.toLowerCase().includes(query))||[];
  const visibleGames=listedGames.slice(0,gameLimit);
  const gameList=useRef<HTMLDivElement|null>(null);
  const resetGameSearch=(value:string)=>{
    updateFilters({gameQuery:value,gameLimit:GAME_PAGE_SIZE});
    if(gameList.current)gameList.current.scrollTop=0;
  };
  const active=useRef<AbortController|null>(null);
  const retryActive=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{
    active.current?.abort();
    const controller=new AbortController();
    active.current=controller;
    setLoading(true);
    setError('');
    try {
      const response=await fetch('/api/sources',{cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error('Source inventory is unavailable. Try again.');
      const result=SourcesSnapshotSchema.safeParse(await response.json());
      if (!result.success) throw new Error('Source inventory changed. Try again.');
      if (!controller.signal.aborted) {setSnapshot(result.data);setRenderNow(Date.now());}
    } catch(error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Source inventory is unavailable.');
    } finally {
      if (active.current===controller) {active.current=null;setLoading(false);}
    }
  },[]);
  const retryChecks=async()=>{
    if(!selectedGameIds.length||retryActive.current)return;
    const controller=new AbortController();
    retryActive.current=controller;
    setRetryState('submitting');
    try{
      const response=await fetch('/api/sources',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({kind:'check-sources',gameIds:selectedGameIds,retry:true}),signal:controller.signal});
      if(!response.ok)throw new Error('Source checks could not restart.');
      if(controller.signal.aborted)return;
      await load();
      if(!controller.signal.aborted)setRetryState('success');
    }catch{if(!controller.signal.aborted)setRetryState('error');}
    finally{if(retryActive.current===controller)retryActive.current=null;}
  };
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>{window.clearTimeout(timer);active.current?.abort();active.current=null;retryActive.current?.abort();retryActive.current=null;};},[load]);
  useEffect(()=>{const timer=window.setInterval(()=>void load(),collecting||pendingEvidence||pendingChecks?3000:15000);
    return()=>window.clearInterval(timer);},[load,collecting,pendingEvidence,pendingChecks]);
  useEffect(()=>{if(!timedChecks)return;const timer=window.setInterval(()=>setRenderNow(Date.now()),5000);
    return()=>window.clearInterval(timer);},[timedChecks]);
  const content=snapshot&&<>
      <p className="source-inventory-time">Snapshot updated {time(snapshot.at)}{loading?' · Updating…':''}</p>
      <p className="source-inventory-scope-note">Feed discovery and checks cover live games and games scheduled for today or tomorrow in America/Chicago.</p>
      <div className="source-inventory-overview" aria-label={`${leagueName[league]} inventory totals`}>
        <div><strong>{sources.length}</strong><span>Sources</span></div>
        <div><strong>{countLabel(scoped?.games.length??0,!!scoped?.unclassifiedGames.length)}</strong><span>Games with listings</span></div>
        <div><strong>{countLabel(scoped?.workingChoices??0,!!scoped?.unclassifiedGames.length)}</strong><span>Available feeds</span></div>
      </div>
      {(scoped?.unclassifiedGames.length??0)>0&&<p className="source-inventory-scope-note" role="note">{scoped?.unclassifiedGames.length} {scoped?.unclassifiedGames.length===1?'game could':'games could'} not be assigned to a league from the current board. Counts may be incomplete; open Games for unclassified details.</p>}
      <details className="source-inventory-explainer"><summary>How these counts work</summary><p>Available feeds passed a media or playback check. Each game shows its pending and failed checks in the feed check results. New feeds are checked before use. Working and failed feeds are rechecked at your chosen interval. Working feeds stay available while rechecks run. A failed check or playback failure marks a feed unavailable. Multiple entries can reach the same server.</p></details>
      <div className="source-inventory-views" role="group" aria-label="Inventory view">
        <button type="button" aria-pressed={view==='sources'} onClick={()=>setView('sources')}>Sources</button>
        <button type="button" aria-pressed={view==='games'} onClick={()=>setView('games')}>Games</button>
      </div>
      {view==='sources'?<>
      <div className="source-inventory-filters"><label>Find a source<input type="search" value={sourceQuery} onChange={event=>updateFilters({sourceQuery:event.target.value})} placeholder="Source name" /></label>
        <label>Show<select value={sourceFilter} onChange={event=>{const value=event.target.value;if(value==='all'||value==='attention'||value==='checked'||value==='listings')updateFilters({sourceFilter:value});}}>
          <option value="all">All</option><option value="attention">Needs attention</option><option value="checked">With available feeds</option><option value="listings">Listings only</option>
        </select></label></div>
      <p className="source-inventory-result" aria-live="polite">Showing {visibleSources.length} of {sources.length} {leagueName[league]} sources</p>
      {visibleSources.length===0?<p className="source-inventory-state">{sources.length===0?'No sources reported yet.':'No sources match these filters.'}</p>:<div className="source-inventory-list source-inventory-source-list">
        {visibleSources.map(({source,matchedGames,workingChoices,links,unclassifiedLinks,incomplete})=><details key={source.id} className="source-inventory-item">
          <summary><span className="source-inventory-source-summary">{branding?<span className="source-inventory-title-row"><LogoMark key={source.id} src={sourceIcons[source.id]} fallback={source.name.slice(0,1).toUpperCase()}/><strong>{source.name}</strong></span>:<strong>{source.name}</strong>}<span>{countLabel(matchedGames,incomplete)} matched games · {countLabel(workingChoices,incomplete)} available feeds{unclassifiedLinks.length?` · ${unclassifiedLinks.length} unclassified links`:''}</span><span className="source-inventory-source-age">{source.id==='sportsurge-v2'?snapshot.sportsurgeV2.current?`Checkpoint ${age(snapshot.sportsurgeV2.current.receivedAt,snapshot.at)}`:'No checkpoint':source.id==='streameast'?snapshot.streameast.current?`Checkpoint ${age(snapshot.streameast.current.receivedAt,snapshot.at)}`:'No checkpoint':source.lastAttempt?`Fetch ${age(source.lastAttempt.at,snapshot.at)}`:'No fetch yet'}</span></span><StatusBadge status={sourceStatus(source,snapshot,league)}/></summary>
          <p>{source.id==='streameast' ? snapshot.streameast.current ? `Shared catalog checkpoint ${time(snapshot.streameast.current.receivedAt)} · ${age(snapshot.streameast.current.receivedAt,snapshot.at)}`:snapshot.browserCollectorsAvailable?'Waiting for browser collection':'Browser collector unavailable':
            source.id==='sportsurge-v2' ? snapshot.sportsurgeV2.current ? `Shared catalog checkpoint ${time(snapshot.sportsurgeV2.current.receivedAt)} · ${age(snapshot.sportsurgeV2.current.receivedAt,snapshot.at)}`:snapshot.browserCollectorsAvailable?'Waiting for browser collection':'Browser collector unavailable':
            source.pending?'Listed for future integration':source.lastAttempt ?
              `Source fetch ${time(source.lastAttempt.at)} · ${age(source.lastAttempt.at,snapshot.at)} · ${attemptLabel[source.lastAttempt.outcome]}${source.lastAttempt.outcome==='failed'&&source.lastAttempt.failure?` · ${failureLabel[source.lastAttempt.failure]}`:''}`:
              'No fetch recorded yet'}
          </p>
          <p>{source.collectionMode==='listings-only'?'Listings only':'Compatible feed discovery'}{source.pending?' · Integration pending':''}</p>
          {source.id!=='sportsurge-v2'&&source.id!=='streameast'&&<CollectionHealth source={source}/>}
          {source.id!=='sportsurge-v2'&&<div className="source-inventory-public-links"><a href={source.catalogUrl} target="_blank" rel="noopener noreferrer">Listing endpoint ↗</a>
            {source.publicUrls.filter(url=>url!==source.catalogUrl).map(url=><a key={url} href={url} target="_blank" rel="noopener noreferrer">{publicLinkLabel(url)} ↗</a>)}</div>}
          {(source.id==='sportsurge-v2'||source.id==='streameast')&&<CollectorHistory source={source} snapshot={snapshot} league={league} now={renderNow}/>}
          {(source.id==='sportsurge-v2'||source.id==='streameast')&&<RetainedCatalogLinks source={source} links={links}
            snapshot={snapshot} league={league} now={renderNow}/>}
          {source.id!=='sportsurge-v2'&&source.id!=='streameast'&&<SourceLinks source={source} links={links} snapshot={snapshot} now={renderNow}/>}
          {unclassifiedLinks.length>0&&<details className="source-inventory-diagnostics"><summary>Unclassified links · {unclassifiedLinks.length}</summary><ul>{unclassifiedLinks.map(link=><li key={link.url}>{link.title} · League not confirmed</li>)}</ul></details>}
          {source.unmatchedListingCount>0&&<details className="source-inventory-diagnostics"><summary>All-league matching diagnostics · {source.unmatchedListingCount} links</summary>
            <ul>{source.unmatchedReasons.map(item=><li key={item.reason}>{matchReasonLabel[item.reason]}: {item.count}</li>)}</ul></details>}
        </details>)}
      </div>}</> : <>
      <h4>{leagueName[league]} games with listed sources</h4>
      <div className="source-inventory-game-search"><label htmlFor={`listed-game-search-${league}`}>Find a listed game</label>
        <div><input id={`listed-game-search-${league}`} type="search" aria-label="Find a listed game" value={gameQuery} onChange={event=>resetGameSearch(event.target.value)} placeholder="Team or game"/>
          <button type="button" onClick={()=>resetGameSearch('')} disabled={!gameQuery}>Clear</button></div>
        <p aria-live="polite">Showing {visibleGames.length} of {listedGames.length} {query?`matching games (${scoped?.games.length??0} listed total)`:'games'}{listedGames.length>0?` · Page ${Math.ceil(visibleGames.length/GAME_PAGE_SIZE)} of ${Math.ceil(listedGames.length/GAME_PAGE_SIZE)}`:''}</p></div>
      {scoped?.games.length===0?<p className="source-inventory-state">No {leagueName[league]} games currently have matched source links.</p>:
        listedGames.length===0?<p className="source-inventory-state">No listed games match your search.</p>:
        <div ref={gameList} className="source-inventory-list source-inventory-game-list" role="region" aria-label={`${leagueName[league]} games with listed sources`} tabIndex={0}
          onScroll={event=>{
            const list=event.currentTarget;
            const nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<80;
            if(nearBottom&&visibleGames.length<listedGames.length)
              updateFilters({gameLimit:Math.min(gameLimit+GAME_PAGE_SIZE,listedGames.length)});
          }}>{visibleGames.map(game=><details key={game.gameId} className="source-inventory-item">
          <summary><span className="source-inventory-source-summary">{branding?<GameTitle name={game.name} game={brandedGames.get(game.gameId)}/>:<strong>{game.name}</strong>}<span>{game.sourceCount} listed sources · {game.workingChoiceCount} available feeds</span></span>{selectedGames.has(game.gameId)&&<span className="source-inventory-badge">Selected</span>}</summary>
          {game.candidates.length>0?<div className="source-inventory-candidates"><strong>Feed check results</strong><ul>{game.candidates.map(candidate=><li key={candidate.id}><span>{candidate.label}</span><span className="source-inventory-check" data-state={candidate.availability.kind}>{candidateEvidence(candidate,renderNow)}{candidate.availability.kind==='playable'||candidate.availability.kind==='unavailable'?` · Checked ${time(candidate.availability.checkedAt)} · ${age(candidate.availability.checkedAt,snapshot.at)}`:''}</span></li>)}</ul></div>:<p>No feeds found yet. The listing evidence below explains each source.</p>}
          {game.sharedRoutes.map(route=><p className="source-inventory-shared-route" key={route.id}>{route.candidateIds.map(id=>game.candidates.find(candidate=>candidate.id===id)?.label||id).join(' and ')} reach the same published server route. These remain separate player entries.</p>)}
          <ul>{game.sourceLinks.map(link=><li key={`${link.sourceId}:${link.url}`}><span>{snapshot.sources.find(source=>source.id===link.sourceId)?.name || link.sourceId}</span>
            {link.sourceId==='sportsurge-v2'?<span>{link.title}</span>:<a href={link.url} target="_blank" rel="noopener noreferrer">{link.title} ↗</a>}{link.freshness==='stale-live'&&<span> · Last seen {time(link.observedAt)}</span>}<ListingEvidence evidence={link.evidence} at={snapshot.at} candidates={game.candidates}/></li>)}</ul>
        </details>)}<div className="source-inventory-game-pagination">{visibleGames.length<listedGames.length?
          <button type="button" className="button subtle" onClick={()=>updateFilters({gameLimit:Math.min(gameLimit+GAME_PAGE_SIZE,listedGames.length)})}>Load more games</button>:
           <span>All {listedGames.length} games shown</span>}</div></div>}
      {(scoped?.unclassifiedGames.length??0)>0&&<details className="source-inventory-diagnostics"><summary>Games awaiting league classification · {scoped?.unclassifiedGames.length}</summary><ul>{scoped?.unclassifiedGames.map(game=><li key={game.gameId}>{game.name}</li>)}</ul></details>}
      </>}
    </>;
  return <section className="source-inventory source-settings" aria-label="Source inventory">
    <div className="source-inventory-heading"><div><h3>Source activity</h3><p>Listings, collection, and feed check evidence for upcoming and live games.</p></div>
      <div className="source-inventory-actions"><button className="button subtle" type="button" onClick={()=>void retryChecks()} disabled={!selectedGameIds.length||retryState==='submitting'}>{retryState==='submitting'?'Retrying checks…':`Retry checks${selectedGameIds.length?` (${selectedGameIds.length})`:''}`}</button>
      <button className="button subtle" type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={14}/>Reload status</button></div></div>
    <p className="source-inventory-feedback" role="status" aria-live="polite">{retryState==='submitting'?'Retry request in progress.':retryState==='success'?'Checks requested for selected games.':retryState==='error'?'Source checks could not restart. Try again.':selectedGameIds.length===0?'Add a game to your room to enable retries.':''}</p>
    {loading&&!snapshot&&<p className="source-inventory-state">Loading source inventory…</p>}
    {error&&<p className="source-inventory-error" role="alert">{error}</p>}
    {snapshot&&<Tabs value={league} onValueChange={value=>{if(value==='nfl'||value==='ncaaf')setSelectedLeague(value);}} className="source-inventory-leagues">
      <TabsList aria-label="Football league"><TabsTrigger value="nfl">NFL</TabsTrigger><TabsTrigger value="ncaaf">NCAA CFB</TabsTrigger></TabsList>
      <TabsContent value="nfl" forceMount hidden={league!=="nfl"}>{league==="nfl"&&content}</TabsContent>
      <TabsContent value="ncaaf" forceMount hidden={league!=="ncaaf"}>{league==="ncaaf"&&content}</TabsContent>
    </Tabs>}
  </section>;
}
