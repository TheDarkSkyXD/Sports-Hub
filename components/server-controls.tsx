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
  const labelFor=(candidate:ServerOption)=>/^(?:Primary|Backup \d+)$/.test(candidate.label)&&candidate.sourceIds?.length?
    `${candidate.sourceIds.map(id=>id.split('-').map(word=>word.charAt(0).toUpperCase()+word.slice(1)).join(' ')).join(', ')} · ${candidate.label}`:
    candidate.label;
  const playable=candidates.filter(candidate=>candidate.availability.kind==='playable').map(candidate=>({candidate,
    label:labelFor(candidate),
  })).sort((left,right)=>left.label.localeCompare(right.label,undefined,{numeric:true,sensitivity:'base'})||
    left.candidate.id.localeCompare(right.candidate.id));
  const index=playable.findIndex(({candidate})=>candidate.id===selectedCandidateId);
  const current=candidates.find(candidate=>candidate.id===selectedCandidateId&&candidate.availability.kind!=='playable');
  const selected=current?.id??(index>=0?playable[index].candidate.id:'');
  const status=current?`Current feed · ${playable.length} verified alternative${playable.length===1?'':'s'}`:
    playable.length?index>=0?`Server ${index+1} of ${playable.length} verified`:
    `${playable.length} verified server${playable.length===1?'':'s'}`:'No verified servers yet';
  return <div className="provider-controls">
    <span title={status}>{status}</span>
    <select aria-label="Choose listed server" value={selected} disabled={disabled||playable.length===0}
      onChange={event=>{if(playable.some(({candidate})=>candidate.id===event.target.value))onSelect?.(event.target.value);}}>
      {selected===''&&<option value="">{playable.length?'No active feed':'No verified servers yet'}</option>}
      {current&&<option value={current.id} disabled>{labelFor(current)}</option>}
      {playable.map(({candidate,label},position)=><option key={candidate.id} value={candidate.id}>{position+1}. {label}</option>)}
    </select>
    <button onClick={onSwitch} disabled={disabled||!onSwitch||playable.length<(current?1:2)} title="Switch provider server">
      <RefreshCw size={12}/>Switch server
    </button>
  </div>;
}
