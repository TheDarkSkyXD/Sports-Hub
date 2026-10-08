import { DEFAULT_FINISHED_GAME_RETENTION_MINUTES, type Board, type CandidateSummary, type Playback, type SourcesSnapshot } from '../lib/football/shared';
import { defaultUpdateFeedUrl, UpdateFeedUrlSchema, type UpdateStatus } from '../lib/desktop-update';
import type { Feed } from '../lib/sunday';

const now = Date.now();

export const demoFeed: Feed = { url: '/sample.webm', label: 'Storybook sample feed' };

export const candidates: CandidateSummary[] = [
  { id: 'sample-primary', gameId: '401', label: 'Primary', sourceIds: ['sportsurge'], observedAt: now,
    availability: { kind: 'playable', checkedAt: now, proof: 'media' } },
  { id: 'sample-backup', gameId: '401', label: 'Backup 1', sourceIds: ['streameast'], observedAt: now,
    availability: { kind: 'playable', checkedAt: now, proof: 'decoded' } },
  { id: 'sample-pending', gameId: '401', label: 'Unverified', sourceIds: ['sportsurge-v2'], observedAt: now,
    availability: { kind: 'checking', progress: { kind: 'queued', since: now - 12_000 } } },
];

export const playback: Playback = {
  session: { id: 'storybook-session', gameId: '401', candidateId: candidates[0].id, generation: 1, state: 'active', graceEndsAt: null },
  candidates,
};

export const sourcesSnapshot: SourcesSnapshot = {
  at: now, revision: 1, windowStartAt: now - 60_000, lastDiscoveryAt: now - 30_000,
  browserCollectorsAvailable: true,
  sportsurgeV2: { current: null, lastComplete: null, previous: null },
  streameast: { current: null, lastComplete: null, previous: null },
  sources: [{
    id: 'sportsurge', name: 'Sportsurge', catalogUrl: 'https://example.invalid/catalog',
    publicUrls: ['https://example.invalid/catalog'], pending: false,
    collectionMode: 'compatible-feed-discovery',
    lastAttempt: { at: now - 30_000, outcome: 'parsed' },
    listingCount: 1, matchedGameCount: 1, staleListingCount: 0, compatibleFeedCount: 1,
    freeChoiceCount:1,workingChoiceCount:1,collectionHealth:{kind:'no-baseline'},
    unmatchedListingCount: 0, unmatchedReasons: [],
    links: [{ title: 'Sample game listing', url: 'https://example.invalid/game', gameId: '401', observedAt: now, freshness: 'fresh',evidence:{kind:'collected',checkedAt:now,candidateIds:['sample-primary']} }],
  }],
  games: [{ gameId: '401', name: 'Green Bay Packers at Chicago Bears', sourceCount: 1, uniqueFeedCount: 1,
    freeChoiceCount:1,workingChoiceCount:1,sharedRoutes:[],
    candidates: [candidates[0]], sourceLinks: [{ sourceId: 'sportsurge', title: 'Sample game listing',
      url: 'https://example.invalid/game', observedAt: now, freshness: 'fresh',evidence:{kind:'collected',checkedAt:now,candidateIds:['sample-primary']} }] }],
};

const team = (id: string, name: string, short: string, abbreviation: string, color: string, score: string | null) =>
  ({ id, name, short, abbreviation, color, score, record: '2-1' });

export const productBoard: Board = {
  schemaVersion: 2, revision: 1, updatedAt: new Date(now).toISOString(), scheduleState: 'ready', aliases: {}, finishedGameRetentionMinutes:DEFAULT_FINISHED_GAME_RETENTION_MINUTES, feedCheckIntervalMinutes:5,
  leagues: {
    nfl: { week: 4, scoresAt: new Date(now).toISOString(), sourceAt: new Date(now).toISOString(), errors: [] },
    ncaaf: { week: 5, scoresAt: new Date(now).toISOString(), sourceAt: new Date(now).toISOString(), errors: [] },
    nba: { scoresAt: new Date(now).toISOString(), sourceAt: new Date(now).toISOString(), errors: [] },
    wnba: { scoresAt: new Date(now).toISOString(), sourceAt: new Date(now).toISOString(), errors: [] },
    ncaab: { scoresAt: new Date(now).toISOString(), sourceAt: new Date(now).toISOString(), errors: [] },
    nhl: { scoresAt: new Date(now).toISOString(), sourceAt: new Date(now).toISOString(), errors: [] },
    ncaah: { scoresAt: new Date(now).toISOString(), sourceAt: new Date(now).toISOString(), errors: [] },
    ncaawh: { scoresAt: new Date(now).toISOString(), sourceAt: new Date(now).toISOString(), errors: [] },
    mlb: { scoresAt: new Date(now).toISOString(), sourceAt: new Date(now).toISOString(), errors: [] },
  },
  games: [
    { id: '401', league: 'nfl', lifecycle: 'live', status: 'in', name: 'Green Bay Packers at Chicago Bears',
      date: new Date(now - 90 * 60_000).toISOString(), detail: 'Q3 08:24', redzone: true,
      away: team('gb', 'Green Bay Packers', 'Packers', 'GB', '203731', '21'),
      home: team('chi', 'Chicago Bears', 'Bears', 'CHI', '0b162a', '17'),
      down: '2nd & 4 at CHI 18', lastPlay: 'A 16-yard pass moves Green Bay into the red zone.',
      venue: 'Soldier Field', broadcast: 'FOX' },
    { id: '402', league: 'nfl', lifecycle: 'live', status: 'in', name: 'Kansas City Chiefs at Buffalo Bills',
      date: new Date(now - 60 * 60_000).toISOString(), detail: 'Q2 03:11', redzone: false,
      away: team('kc', 'Kansas City Chiefs', 'Chiefs', 'KC', 'e31837', '14'),
      home: team('buf', 'Buffalo Bills', 'Bills', 'BUF', '00338d', '10'),
      down: '1st & 10 at BUF 43', venue: 'Highmark Stadium', broadcast: 'CBS' },
    { id: 'ncaaf-501', league: 'ncaaf', lifecycle: 'live', status: 'in', name: 'Georgia Bulldogs at Alabama Crimson Tide',
      date: new Date(now - 75 * 60_000).toISOString(), detail: 'Q2 12:08', redzone: false,
      away: team('uga', 'Georgia Bulldogs', 'Georgia', 'UGA', 'ba0c2f', '10'),
      home: team('bama', 'Alabama Crimson Tide', 'Alabama', 'ALA', '9e1b32', '7'),
      down: '3rd & 6 at UGA 47', venue: 'Bryant-Denny Stadium', broadcast: 'ABC' },
    { id: 'ncaaf-502', league: 'ncaaf', lifecycle: 'scheduled', status: 'pre', name: 'Michigan Wolverines at Ohio State Buckeyes',
      date: new Date(now + 2 * 60 * 60_000).toISOString(), detail: 'Scheduled', redzone: false,
      away: team('mich', 'Michigan Wolverines', 'Michigan', 'MICH', '00274c', null),
      home: team('osu', 'Ohio State Buckeyes', 'Ohio State', 'OSU', 'bb0000', null),
      venue: 'Ohio Stadium', broadcast: 'FOX' },
  ],
};

const sourceUrl = UpdateFeedUrlSchema.parse(defaultUpdateFeedUrl);
const release = { version: '1.1.0', pageUrl: 'https://example.invalid/releases/1.1.0', notes: 'Sample release notes.', publishedAt: now };
const commonStatus = {
  currentVersion: '1.0.6',
  source: { url: sourceUrl, editable: false },
  preferences: { autoCheckEnabled: true, checkFrequency: 'daily' },
} satisfies Pick<UpdateStatus, 'currentVersion' | 'source' | 'preferences'>;

export const availableUpdate: UpdateStatus = {
  ...commonStatus, state: { kind: 'available', release, lastCheckedAt: now }, commands: ['check', 'download'],
};
export const downloadingUpdate: UpdateStatus = {
  ...commonStatus, state: { kind: 'downloading', release, percent: 42 }, commands: [],
};
export const currentUpdate: UpdateStatus = {
  ...commonStatus, state: { kind: 'current', lastCheckedAt: now }, commands: ['check'],
};
