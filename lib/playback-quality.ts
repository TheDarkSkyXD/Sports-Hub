export type QualityLevel = {
  index: number;
  height: number;
  bitrate: number;
};

export const qualityPreferences = [
  { value: 'auto', label: 'Auto' },
  { value: 'best', label: 'Highest available' },
  { value: '2160', label: '2160p' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' },
] as const;

export type QualityPreference = (typeof qualityPreferences)[number]['value'];

export function parseQualityPreference(value: unknown): QualityPreference {
  return qualityPreferences.find(option => option.value === value)?.value ?? 'auto';
}

export function chooseDefaultLevel({ preference, levels }: {
  preference: QualityPreference;
  levels: readonly QualityLevel[];
}): number {
  if (preference === 'auto') return -1;
  const known = levels.filter(level => Number.isFinite(level.height) && level.height > 0);
  if (known.length === 0) return -1;
  const target = preference === 'best' ? Infinity : Number(preference);
  const below = known.filter(level => level.height <= target);
  const candidates = below.length > 0 ? below : known;
  const selectedHeight = below.length > 0
    ? Math.max(...candidates.map(level => level.height))
    : Math.min(...candidates.map(level => level.height));
  const sameHeight = candidates.filter(level => level.height === selectedHeight);
  sameHeight.sort((left, right) => {
    const leftBitrate = Number.isFinite(left.bitrate) && left.bitrate > 0 ? left.bitrate : 0;
    const rightBitrate = Number.isFinite(right.bitrate) && right.bitrate > 0 ? right.bitrate : 0;
    return rightBitrate - leftBitrate || left.index - right.index;
  });
  return sameHeight[0].index;
}
