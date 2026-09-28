'use client';

import { RefreshCw } from 'lucide-react';
import type { CandidateSummary } from '@/lib/football/shared';

export type ServerOption = Pick<CandidateSummary,'id'|'label'|'sourceIds'|'availability'>;

type Props = {
  candidates: readonly ServerOption[];
  selectedCandidateId?: string;
  onSelect?: (candidateId: string) => void;
  onSwitch?: () => void;
  disabled?: boolean;
};

export function ServerControls({candidates,selectedCandidateId,onSelect,onSwitch,disabled=false}:Props) {
  const playable=candidates.filter(candidate=>candidate.availability.kind==='playable');
  const index=playable.findIndex(candidate=>candidate.id===selectedCandidateId);
  const selected=index>=0?selectedCandidateId:'';
  const status=playable.length?index>=0?`Server ${index+1} of ${playable.length} verified`:
    `${playable.length} verified server${playable.length===1?'':'s'}`:'No verified servers yet';
  return <div className="provider-controls">
    <span title={status}>{status}</span>
    <select aria-label="Choose listed server" value={selected} disabled={disabled||playable.length===0}
      onChange={event=>{if(playable.some(candidate=>candidate.id===event.target.value))onSelect?.(event.target.value);}}>
      {selected===''&&<option value="">{playable.length?'Choose a server':'No verified servers yet'}</option>}
      {playable.map((candidate,position)=><option key={candidate.id} value={candidate.id}>{position+1}. {candidate.label}{
        /^(?:Primary|Backup \d+)$/.test(candidate.label)&&candidate.sourceIds?.length?` · ${candidate.sourceIds.join(', ')}`:''}</option>)}
    </select>
    <button onClick={onSwitch} disabled={disabled||!onSwitch||playable.length<2} title="Switch provider server">
      <RefreshCw size={12}/>Switch server
    </button>
  </div>;
}
