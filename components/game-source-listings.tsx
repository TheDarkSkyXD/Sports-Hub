'use client';

import { useEffect, useState } from 'react';
import { SourcesSnapshotSchema, type SourcesSnapshot } from '@/lib/football/shared';

type SourceLink = SourcesSnapshot['games'][number]['sourceLinks'][number];
type SourceGroup = { id:string; name:string; links:SourceLink[] };
type Listings = { gameId:string; at:number; groups:SourceGroup[]; compatibleStreams:number };

function confirmedListings(snapshot:SourcesSnapshot,gameId:string):Listings {
  const game=snapshot.games.find(item=>item.gameId===gameId);
  const names=new Map(snapshot.sources.map(source=>[source.id,source.name]));
  const groups=new Map<string,SourceGroup>();
  for (const link of game?.sourceLinks || []) {
    if (!names.has(link.sourceId)) continue;
    const group=groups.get(link.sourceId) || {id:link.sourceId,name:names.get(link.sourceId) || link.sourceId,links:[]};
    if (!group.links.some(existing=>existing.url===link.url)) group.links.push(link);
    groups.set(link.sourceId,group);
  }
  return {gameId,at:snapshot.at,groups:[...groups.values()],compatibleStreams:game?.uniqueFeedCount || 0};
}

export function GameSourceListings({gameId}:{gameId:string}) {
  const [open,setOpen]=useState(false);
  const [listings,setListings]=useState<Listings|null>(null);
  const [error,setError]=useState<{gameId:string;message:string}|null>(null);
  const [loading,setLoading]=useState(false);
  const current=listings?.gameId===gameId?listings:null;
  const currentError=error?.gameId===gameId?error.message:null;

  useEffect(()=>{
    if (!open) return;
    let active=true;
    let poll:number|undefined;
    let controller:AbortController|null=null;
    const load=async()=>{
      const request=new AbortController();
      controller=request;
      let timedOut=false;
      const deadline=window.setTimeout(()=>{timedOut=true;request.abort();},15000);
      setLoading(true);
      try {
        const response=await fetch('/api/sources',{cache:'no-store',signal:request.signal});
        if (!response.ok) throw new Error('Source listings are unavailable.');
        const result=SourcesSnapshotSchema.safeParse(await response.json());
        if (!result.success) throw new Error('Source listings changed.');
        if (!active) return;
        setListings(confirmedListings(result.data,gameId));
        setError(null);
      } catch {
        if (!active) return;
        setError({gameId,message:timedOut?'Source listings timed out.':'Source listings could not be loaded.'});
      } finally {
        window.clearTimeout(deadline);
        controller=null;
        if (active) {
          setLoading(false);
          poll=window.setTimeout(()=>void load(),30000);
        }
      }
    };
    void load();
    return ()=>{active=false;if(poll!==undefined)window.clearTimeout(poll);controller?.abort();};
  },[open,gameId]);

  return <details className="game-source-listings" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Sources{current&&<span>({current.groups.length})</span>}</summary>
    {open&&<div className="game-source-listings-body">
      {loading&&!current&&<p>Loading confirmed source listings…</p>}
      {currentError&&<p className="game-source-listings-error" role="alert">{currentError}
        {current&&` Showing the last successful list from ${new Date(current.at).toLocaleString()}.`} Checks continue automatically.</p>}
      {current&&<>
        <p>{current.compatibleStreams} compatible {current.compatibleStreams===1?'stream':'streams'} (untested).
          {current.compatibleStreams===0?' These public listings are not selectable feeds.':' The listings below open source pages and are not selectable feeds.'}</p>
        {current.groups.length===0?<p>No confirmed source listings for this game.</p>:
          <ul>{current.groups.map(group=><li key={group.id}>
            <strong>{group.name}</strong>
            <ul>{group.links.map(link=><li key={link.url}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title} ↗</a>
              {link.freshness==='stale-live'&&<span>Last seen {new Date(link.observedAt).toLocaleString()}</span>}
            </li>)}</ul>
          </li>)}</ul>}
      </>}
    </div>}
  </details>;
}
