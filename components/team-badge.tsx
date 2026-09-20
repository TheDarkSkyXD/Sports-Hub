'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { Team } from '@/lib/sunday';

export function TeamBadge({ team, large = false }: { team: Team; large?: boolean }) {
  const [failedSource, setFailedSource] = useState<string>();
  return <span className={`team-badge ${large ? 'large' : ''}`} style={{ '--team': `#${team.color}` } as CSSProperties}>
    {team.logo && failedSource !== team.logo
      ? <img src={team.logo} alt="" onError={() => setFailedSource(team.logo)}/>
      : team.abbreviation}
  </span>;
}
