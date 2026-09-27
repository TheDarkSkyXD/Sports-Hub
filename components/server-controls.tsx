'use client';

import { RefreshCw } from 'lucide-react';
import type { CandidateSummary, SourcesSnapshot } from '@/lib/football/shared';

export type ServerOption = Pick<CandidateSummary,'id'|'label'|'sourceIds'>;
export type DiscoveredServer = { id: string; label: string };

export function discoveredServersForGame(snapshot: SourcesSnapshot | null, gameId: string): DiscoveredServer[] {
  const links = snapshot?.games.find(game => game.gameId === gameId)?.sourceLinks;
  if (!snapshot || !links) return [];
  const belongsToGame = (sourceId: string, url: string) => links.some(link =>
    link.sourceId === sourceId && link.url === url && link.freshness === 'fresh' &&
    link.observedAt >= snapshot.windowStartAt && link.observedAt <= snapshot.at + 60_000);
  const recent = (at: number) => at >= snapshot.windowStartAt && at <= snapshot.at + 60_000;
  const discovered: DiscoveredServer[] = [];
  const seenIds = new Set<string>();
  const seenDestinations = new Set<string>();

  const sportsurge = snapshot.sportsurgeV2.current;
  if (sportsurge) for (const event of sportsurge.games) {
    const category = sportsurge.categories[event.league];
    if (!belongsToGame('sportsurge-v2', event.url) || event.gameId !== null && event.gameId !== gameId ||
      category.kind !== 'collected' || event.detail.kind !== 'collected' ||
      !recent(category.at) || !recent(event.detail.at) || event.detail.at < category.at) continue;
    for (const provider of event.detail.providers) {
      if (provider.destination.kind !== 'link' || !recent(provider.observedAt)) continue;
      const id = `sportsurge-v2:${event.id}:${provider.id}`;
      if (seenIds.has(id) || seenDestinations.has(provider.destination.url)) continue;
      seenIds.add(id);
      seenDestinations.add(provider.destination.url);
      discovered.push({id,label:`Sportsurge v2 · ${provider.label}`});
    }
  }

  const streameast = snapshot.streameast.current;
  if (streameast) for (const event of streameast.games) {
    const category = streameast.categories[event.league];
    if (!belongsToGame('streameast', event.url) || event.gameId !== null && event.gameId !== gameId ||
      category.kind !== 'collected' || event.detail.kind !== 'collected' ||
      !recent(category.at) || !recent(event.detail.at) || event.detail.at < category.at) continue;
    for (const server of event.detail.servers) {
      const availability = server.availability;
      const id = availability.kind === 'free-channel' ? `streameast:${availability.channelId}` :
        availability.kind === 'free-wikisport' ? `wikisport:${availability.section}:${availability.playerId}` :
        availability.kind === 'free-unsupported' || availability.kind === 'free-unresolved' ?
          `streameast:${event.id}:${server.id}` : null;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      discovered.push({id,label:`StreamEast · ${server.label}`});
    }
  }
  return discovered;
}

type Props = {
  candidates: readonly ServerOption[];
  selectedCandidateId?: string;
  discovered: readonly DiscoveredServer[];
  onSelect?: (candidateId: string) => void;
  onSwitch?: () => void;
  disabled?: boolean;
};

export function ServerControls({candidates,selectedCandidateId,discovered,onSelect,onSwitch,disabled=false}:Props) {
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const listings = discovered;
  const index = candidates.findIndex(candidate => candidate.id === selectedCandidateId);
  const selected = index >= 0 ? selectedCandidateId : '';
  const listingCount = listings.length ? ` · ${listings.length} listing${listings.length === 1 ? '' : 's'}` : '';
  const status = candidates.length ? index >= 0 ? `Server ${index + 1} of ${candidates.length}${listingCount}` :
    `${candidates.length} compatible server${candidates.length === 1 ? '' : 's'}${listingCount}` :
    listings.length ? `${listings.length} discovered listings · 0 compatible` : 'No compatible servers yet';
  const enabled = !disabled;
  return <div className="provider-controls">
    <span title={status}>{status}</span>
    <select aria-label="Choose listed server" value={selected} disabled={!enabled || candidates.length === 0 && listings.length === 0}
      onChange={event => {if (candidateIds.has(event.target.value)) onSelect?.(event.target.value);}}>
      {selected === '' && <option value="">{listings.length ? `${listings.length} listings · ${candidates.length} compatible` : 'Choose a compatible server'}</option>}
      {candidates.length > 0 && <optgroup label="Compatible servers">
        {candidates.map((candidate,position) => <option key={candidate.id} value={candidate.id}>{position + 1}. {candidate.label}{
          /^(?:Primary|Backup \d+)$/.test(candidate.label) && candidate.sourceIds?.length ? ` · ${candidate.sourceIds.join(', ')}` : ''}</option>)}
      </optgroup>}
      {listings.length > 0 && <optgroup label="Discovered listings">
        {listings.map(server => <option key={server.id} value={`discovered:${server.id}`} disabled>{server.label} · playback unverified</option>)}
      </optgroup>}
    </select>
    <button onClick={onSwitch} disabled={!enabled || !onSwitch || candidates.length < 2} title="Switch provider server">
      <RefreshCw size={12}/>Switch server
    </button>
  </div>;
}
