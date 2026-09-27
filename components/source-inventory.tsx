'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { SourcesSnapshotSchema, type SourcesSnapshot, type SportsurgeCatalogView } from '@/lib/football/shared';

const attemptLabel:Record<NonNullable<SourcesSnapshot['sources'][number]['lastAttempt']>['outcome'],string>={
  parsed:'Fetched',empty:'No listings',unsupported:'Unsupported page','parser-changed':'Parser changed',failed:'Last fetch failed',
};
const matchReasonLabel:Record<SourcesSnapshot['sources'][number]['unmatchedReasons'][number]['reason'],string>={
  'not-a-matchup':'No clear matchup','unknown-teams':'Teams not recognized','unverified-kickoff':'Kickoff not verified',
  'ambiguous-matchup':'Ambiguous matchup','conflicting-date':'Conflicting kickoff','finished-game':'Game finished',other:'Other matching reason',
};
const time=(value:number)=>new Date(value).toLocaleString();
const age=(value:number,now:number)=>`${Math.max(0,Math.floor((now-value)/60_000))} min old`;
const publicLinkLabel=(value:string)=>{const url=new URL(value);return `${url.hostname}${url.pathname}${url.hash}`;};
const collectionLabel=(value:SportsurgeCatalogView['state'])=>value.kind==='collecting'?'Collecting':value.kind==='complete'?'Complete':`Partial (${value.reason})`;
const categoryLabel=(value:SportsurgeCatalogView['categories']['ncaaf'])=>value.kind==='collected'?'collected':value.kind==='pending'?'pending':`failed (${value.reason})`;

function SportsurgeRun({run}:{run:SportsurgeCatalogView}) {
  return <div className="source-inventory-catalog">
    <p>{run.interrupted?'Interrupted':collectionLabel(run.state)} · Started {time(run.startedAt)} · Last checkpoint {time(run.receivedAt)}</p>
    <p>CFB {categoryLabel(run.categories.ncaaf)} · NFL {categoryLabel(run.categories.nfl)}</p>
    <p>{run.gameCount} games · {run.collectedDetails} details collected · {run.pendingDetails} pending · {run.failedDetails} failed</p>
    <p>{run.providerRows} provider rows · {run.rejectedProviders} rejected destinations · {run.rejectedGames.length} rejected game links · {run.catalogIssues.length} duplicate-ID notices</p>
    {run.rejectedGames.length>0&&<details className="source-inventory-diagnostics"><summary>Rejected game links</summary><ul>
      {run.rejectedGames.map((game,index)=><li key={`${game.league}:${index}`}>{game.title || `${game.league.toUpperCase()} listing`}: {game.reason}</li>)}
    </ul></details>}
    {run.catalogIssues.length>0&&<details className="source-inventory-diagnostics"><summary>Catalog identity notices</summary><ul>
      {run.catalogIssues.map((issue,index)=><li key={`${issue.league}:${index}`}>{issue.title}: {issue.reason}</li>)}
    </ul></details>}
    <div className="source-inventory-list">{run.games.map(game=><details key={game.url} className="source-inventory-item">
      <summary><strong>{game.title}</strong><span>{game.detail.kind==='collected'?`${game.detail.providers.length} provider rows`:game.detail.kind==='failed'?`Detail failed (${game.detail.reason})`:'Detail pending'}</span></summary>
      <p><a href={game.url} target="_blank" rel="noopener noreferrer">Game listing ↗</a> · {game.gameId?'Matched to ESPN':matchReasonLabel[game.matchReason || 'other']}</p>
      {game.detail.kind==='collected'&&<ul>{game.detail.providers.map(provider=><li key={provider.id}>
        {provider.destination.kind==='link'?<a href={provider.destination.url} target="_blank" rel="noopener noreferrer">{provider.label} ↗</a>:
          <span>{provider.label} · {provider.destination.kind==='malformed'?'Malformed':'Rejected'} ({provider.destination.reason}){provider.destination.kind==='rejected'&&provider.destination.display?` · ${provider.destination.display}`:''}</span>}
      </li>)}</ul>}
    </details>)}</div>
  </div>;
}

export function SourceInventory() {
  const [snapshot,setSnapshot]=useState<SourcesSnapshot|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const collecting=snapshot?.sportsurgeV2.current?.state.kind==='collecting';
  const active=useRef<AbortController|null>(null);
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
      if (!controller.signal.aborted) setSnapshot(result.data);
    } catch(error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Source inventory is unavailable.');
    } finally {
      if (active.current===controller) {active.current=null;setLoading(false);}
    }
  },[]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>{window.clearTimeout(timer);active.current?.abort();active.current=null;};},[load]);
  useEffect(()=>{const timer=window.setInterval(()=>void load(),collecting?3000:15000);
    return()=>window.clearInterval(timer);},[load,collecting]);
  return <section className="source-inventory" aria-label="Source inventory">
    <div className="source-inventory-heading"><div><h3>Sources</h3><p>Public listings and compatible feeds seen in the last 30 minutes. Counts do not test playback.</p></div>
      <button className="button subtle" type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={14}/>Refresh</button></div>
    {loading&&!snapshot&&<p className="source-inventory-state">Loading source inventory…</p>}
    {error&&<p className="source-inventory-error" role="alert">{error}</p>}
    {snapshot&&<>
      <p className="source-inventory-time">Last scan {snapshot.lastDiscoveryAt ? time(snapshot.lastDiscoveryAt) : 'not yet available'} · Snapshot {time(snapshot.at)}</p>
      <div className="source-inventory-list">
        {snapshot.sources.map(source=><details key={source.id} className="source-inventory-item">
          <summary><strong>{source.name}</strong><span>{source.id==='sportsurge-v2' ? snapshot.sportsurgeV2.current ?
            `${snapshot.sportsurgeV2.current.gameCount} games · ${snapshot.sportsurgeV2.current.providerRows} provider rows · ${collectionLabel(snapshot.sportsurgeV2.current.state)}`:
            'Awaiting first collection' : source.pending?'Integration pending':`${source.listingCount} links · ${source.matchedGameCount} games`}</span></summary>
          <p>{source.id==='sportsurge-v2' ? snapshot.sportsurgeV2.current ? `Last browser checkpoint ${time(snapshot.sportsurgeV2.current.receivedAt)}`:'No browser collection recorded yet':
            source.pending?'Listed for future integration':source.lastAttempt ? `${attemptLabel[source.lastAttempt.outcome]} ${time(source.lastAttempt.at)}`:'No fetch recorded yet'}
          </p>
          <div className="source-inventory-public-links"><a href={source.catalogUrl} target="_blank" rel="noopener noreferrer">Listing endpoint ↗</a>
            {source.publicUrls.filter(url=>url!==source.catalogUrl).map(url=><a key={url} href={url} target="_blank" rel="noopener noreferrer">{publicLinkLabel(url)} ↗</a>)}</div>
          {source.id==='sportsurge-v2'&&snapshot.sportsurgeV2.current&&<SportsurgeRun run={snapshot.sportsurgeV2.current}/>}
          {source.id==='sportsurge-v2'&&snapshot.sportsurgeV2.lastComplete&&snapshot.sportsurgeV2.lastComplete.runId!==snapshot.sportsurgeV2.current?.runId&&
            <details className="source-inventory-diagnostics"><summary>Previous complete scan · {age(snapshot.sportsurgeV2.lastComplete.receivedAt,snapshot.at)} · {time(snapshot.sportsurgeV2.lastComplete.receivedAt)}</summary>
              <SportsurgeRun run={snapshot.sportsurgeV2.lastComplete}/></details>}
          {source.id==='sportsurge-v2'&&snapshot.sportsurgeV2.previous&&snapshot.sportsurgeV2.previous.runId!==snapshot.sportsurgeV2.current?.runId&&
            <details className="source-inventory-diagnostics"><summary>Previous interrupted or partial scan · {age(snapshot.sportsurgeV2.previous.receivedAt,snapshot.at)} · {time(snapshot.sportsurgeV2.previous.receivedAt)}</summary>
              <SportsurgeRun run={snapshot.sportsurgeV2.previous}/></details>}
          {source.id!=='sportsurge-v2'&&source.links.length>0&&<ul>{source.links.map(link=><li key={link.url}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.title} ↗</a></li>)}</ul>}
          {source.unmatchedListingCount>0&&<details className="source-inventory-diagnostics"><summary>Matching diagnostics · {source.unmatchedListingCount} links</summary>
            <ul>{source.unmatchedReasons.map(item=><li key={item.reason}>{matchReasonLabel[item.reason]}: {item.count}</li>)}</ul></details>}
        </details>)}
      </div>
      <h4>Games with listed sources</h4>
      {snapshot.games.length===0?<p className="source-inventory-state">No current links match a scheduled game.</p>:
        <div className="source-inventory-list">{snapshot.games.map(game=><details key={game.gameId} className="source-inventory-item">
          <summary><strong>{game.name}</strong><span>{game.sourceCount} sources · {game.uniqueFeedCount} compatible feeds (untested)</span></summary>
          <ul>{game.sourceLinks.map(link=><li key={`${link.sourceId}:${link.url}`}><span>{snapshot.sources.find(source=>source.id===link.sourceId)?.name || link.sourceId}</span>
            <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title} ↗</a></li>)}</ul>
        </details>)}</div>}
    </>}
  </section>;
}
