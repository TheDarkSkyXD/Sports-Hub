'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { SourcesSnapshotSchema, type SourcesSnapshot } from '@/lib/football/shared';

const attemptLabel:Record<NonNullable<SourcesSnapshot['sources'][number]['lastAttempt']>['outcome'],string>={
  parsed:'Fetched',empty:'No listings',unsupported:'Unsupported page','parser-changed':'Parser changed',failed:'Last fetch failed',
};
const matchReasonLabel:Record<SourcesSnapshot['sources'][number]['unmatchedReasons'][number]['reason'],string>={
  'not-a-matchup':'No clear matchup','unknown-teams':'Teams not recognized','unverified-kickoff':'Kickoff not verified',
  'ambiguous-matchup':'Ambiguous matchup','conflicting-date':'Conflicting kickoff','finished-game':'Game finished',other:'Other matching reason',
};
const time=(value:number)=>new Date(value).toLocaleString();
const publicLinkLabel=(value:string)=>{const url=new URL(value);return `${url.hostname}${url.pathname}${url.hash}`;};

export function SourceInventory() {
  const [snapshot,setSnapshot]=useState<SourcesSnapshot|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
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
  return <section className="source-inventory" aria-label="Source inventory">
    <div className="source-inventory-heading"><div><h3>Sources</h3><p>Public listings and compatible feeds seen in the last 30 minutes. Counts do not test playback.</p></div>
      <button className="button subtle" type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={14}/>Refresh</button></div>
    {loading&&!snapshot&&<p className="source-inventory-state">Loading source inventory…</p>}
    {error&&<p className="source-inventory-error" role="alert">{error}</p>}
    {snapshot&&<>
      <p className="source-inventory-time">Last scan {snapshot.lastDiscoveryAt ? time(snapshot.lastDiscoveryAt) : 'not yet available'} · Snapshot {time(snapshot.at)}</p>
      <div className="source-inventory-list">
        {snapshot.sources.map(source=><details key={source.id} className="source-inventory-item">
          <summary><strong>{source.name}</strong><span>{source.pending?'Integration pending':`${source.listingCount} links · ${source.matchedGameCount} games`}</span></summary>
          <p>{source.pending?'Listed for future integration':source.lastAttempt ? `${attemptLabel[source.lastAttempt.outcome]} ${time(source.lastAttempt.at)}`:'No fetch recorded yet'}
          </p>
          <div className="source-inventory-public-links"><a href={source.catalogUrl} target="_blank" rel="noopener noreferrer">Listing endpoint ↗</a>
            {source.publicUrls.filter(url=>url!==source.catalogUrl).map(url=><a key={url} href={url} target="_blank" rel="noopener noreferrer">{publicLinkLabel(url)} ↗</a>)}</div>
          {source.links.length>0&&<ul>{source.links.map(link=><li key={link.url}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.title} ↗</a></li>)}</ul>}
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
