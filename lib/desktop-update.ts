import { z } from 'zod';

// A maintainer changes the channel by editing this one constant. Nothing else in the
// app carries a repository name, and `SUNDAY_ROOM_UPDATE_SOURCE` only wins when the
// app is not packaged, so a stray variable cannot redirect the feed in a shipped build.
export const defaultReleaseRepo = 'TheDarkSkyXD/Sports-Hub';

export const updateCommands = ['check', 'download', 'cancel', 'install'] as const;
export const UpdateCommandSchema = z.enum(updateCommands);
export type UpdateCommand = (typeof updateCommands)[number];

export const UnsupportedReasonSchema = z.enum(['platform']);
export type UnsupportedReason = z.infer<typeof UnsupportedReasonSchema>;
export const FailureReasonSchema = z.enum(['offline', 'rate-limited', 'unavailable', 'malformed', 'checksum', 'download', 'install']);
export type FailureReason = z.infer<typeof FailureReasonSchema>;
export const RetrySchema = z.enum(['check', 'download', 'install']).nullable();
export type Retry = z.infer<typeof RetrySchema>;

// `owner/name`, never a URL. The feed address and the release page address are both
// derived from the slug, so a source cannot point the updater at an arbitrary host.
export const releaseRepoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const ReleaseRepoSchema = z.string().regex(releaseRepoPattern).brand<'ReleaseRepo'>();
export type ReleaseRepo = z.infer<typeof ReleaseRepoSchema>;

/**
 * Accepts the releases URL a person pastes, and returns the slug the updater stores.
 *
 * A URL is required, not a bare `owner/name`: without an address there is nothing to
 * direct the reader to, so an unresolvable source is a mistake worth reporting rather
 * than guessing at. Only `https://github.com` is honoured and only its `/owner/name`
 * shape is kept, so a stored source still cannot point the updater at an arbitrary host.
 */
export function parseReleaseSource(input: string): ReleaseRepo | null {
  const trimmed = input.trim();
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  // `URL` resolves `..` and decodes `%2e` while parsing, so a traversal like
  // `/owner/name/releases/../../elsewhere` is already collapsed to `/owner/elsewhere` by
  // the time `pathname` is readable. A legitimate GitHub owner or name can never be `.`
  // or `..`, so the raw text is the only place the attempt is still visible.
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(trimmed) || /%2e/i.test(trimmed) || trimmed.includes('\\')) return null;
  // An empty segment is refused rather than dropped: dropping `//name/releases` would
  // read `name` as the owner, which is a different repository than the one pasted.
  const segments = url.pathname.split('/').slice(1);
  if (segments.some(segment => segment === '')) return null;
  const parts = segments.filter(Boolean);
  // The releases page, any page under it (`/releases/latest`, `/releases/tag/v1.0.2`), or
  // the repo root. Each is a page a person could paste from a browser, and all three name
  // the same slug. `/tree/main` or `/issues` is some other page, not an update source.
  if (parts.length < 2 || (parts[2] !== undefined && parts[2] !== 'releases')) return null;
  const slug = `${parts[0]}/${parts[1]}`;
  return releaseRepoPattern.test(slug) ? slug as ReleaseRepo : null;
}

export const ReleaseInfoSchema = z.object({
  version: z.string(),
  pageUrl: z.string().url(),
  notes: z.string(),
  publishedAt: z.number().int().nonnegative().nullable(),
  installer: z.object({
    name: z.string(),
    url: z.string().url(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  }),
}).readonly();
export type ReleaseInfo = z.infer<typeof ReleaseInfoSchema>;

// `failed` carries a nullable release rather than an absent one, so a failed refresh
// can still render the release it already knows about. There is deliberately no
// `restarting` variant: the installer relaunches the app, so the process that would
// render it is already gone and any state visible for zero milliseconds only lies.
export const UpdateStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported'), reason: UnsupportedReasonSchema }),
  z.object({ kind: z.literal('idle'), lastCheckedAt: z.number().int().nonnegative().nullable() }),
  // A re-check keeps the release it already found, so asking GitHub again never costs the
  // user an update they were about to install.
  z.object({ kind: z.literal('checking'), release: ReleaseInfoSchema.optional() }),
  z.object({ kind: z.literal('current'), lastCheckedAt: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('available'), release: ReleaseInfoSchema, lastCheckedAt: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('downloading'), release: ReleaseInfoSchema, received: z.number().int().nonnegative(), total: z.number().int().positive() }),
  z.object({ kind: z.literal('ready'), release: ReleaseInfoSchema, bytes: z.number().int().positive(), verifiedAt: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('installing'), release: ReleaseInfoSchema }),
  z.object({ kind: z.literal('failed'), reason: FailureReasonSchema, detail: z.string(), retry: RetrySchema, release: ReleaseInfoSchema.nullable() }),
]).readonly();
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const UpdateStatusSchema = z.object({
  currentVersion: z.string(),
  source: z.object({
    repo: ReleaseRepoSchema,
    origin: z.enum(['packaged', 'file', 'environment']),
    // A packaged build fixes its source, because the binary is unsigned and the source
    // decides which installer it will run. The settings field follows this.
    editable: z.boolean(),
  }).readonly(),
  state: UpdateStateSchema,
  commands: z.array(UpdateCommandSchema).readonly(),
}).readonly();
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export type DesktopUpdateBridge = Readonly<{
  get(): Promise<UpdateStatus>;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  cancel(): Promise<UpdateStatus>;
  install(): Promise<UpdateStatus>;
  setSource(repo: string): Promise<UpdateStatus>;
  subscribe(listener: (status: UpdateStatus) => void): () => void;
}>;

declare global { interface Window { sundayDesktop?: DesktopUpdateBridge } }

const failureLine: Record<FailureReason, string> = {
  offline: 'Sunday Room could not reach the release source.',
  'rate-limited': 'The release source has almost no request budget left for this address.',
  unavailable: 'The release source is unavailable. It may be private, renamed, or hold no published release yet.',
  malformed: 'The release source returned something this version of Sunday Room cannot read.',
  checksum: 'The downloaded installer did not match the published size and checksum.',
  download: 'The installer could not be downloaded.',
  install: 'The installer could not be started.',
};

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

// The source is stored as a slug so it can never point the updater at an arbitrary host.
// The addresses below are derived from that slug, so showing a link cannot widen the
// trust boundary the schema sets.
export function releaseFeedUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

export function releasePageUrl(repo: string): string {
  return `https://github.com/${repo}/releases`;
}

export function describeStatus(status: UpdateStatus): string {
  const state = status.state;
  switch (state.kind) {
    case 'unsupported':
      return 'Automatic updates run only on the Windows desktop app.';
    case 'idle':
      return `Version ${status.currentVersion}. Not checked yet.`;
    case 'checking':
      return 'Checking for a newer version…';
    case 'current':
      return `Sunday Room ${status.currentVersion} is up to date.`;
    case 'available':
      return `Sunday Room ${state.release.version} is available.`;
    case 'downloading':
      return `Downloading Sunday Room ${state.release.version}: ${megabytes(state.received)} of ${megabytes(state.total)}.`;
    case 'ready':
      return `Sunday Room ${state.release.version} is downloaded. Installing restarts Sunday Room.`;
    case 'installing':
      return `Installing Sunday Room ${state.release.version}. Sunday Room will close.`;
    case 'failed':
      return `${failureLine[state.reason]} ${state.detail}`.trim();
  }
}
