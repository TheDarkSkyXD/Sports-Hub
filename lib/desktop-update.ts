import { z } from 'zod';

// A maintainer changes the feed by editing this one constant, which `desktop/update.cjs`
// duplicates. `SUNDAY_ROOM_UPDATE_SOURCE` only wins when the app is not packaged, so a
// stray variable cannot redirect a shipped build.
export const defaultReleaseRepo = 'TheDarkSkyXD/Sports-Hub';

// electron-updater has no cancel: it owns the transfer and exposes no way to abort it,
// so offering one would be a control that silently does nothing. While a download runs
// the primary action is disabled and shows progress instead, which is what the T3 Code
// desktop app does.
export const updateCommands = ['check', 'download', 'install'] as const;
export const UpdateCommandSchema = z.enum(updateCommands);
export type UpdateCommand = (typeof updateCommands)[number];

export const UnsupportedReasonSchema = z.enum(['platform']);
export type UnsupportedReason = z.infer<typeof UnsupportedReasonSchema>;
export const FailureReasonSchema = z.enum(['offline', 'rate-limited', 'unavailable', 'malformed', 'checksum', 'download', 'install']);
export type FailureReason = z.infer<typeof FailureReasonSchema>;
export const RetrySchema = z.enum(['check', 'download', 'install']).nullable();
export type Retry = z.infer<typeof RetrySchema>;

// A plain HTTPS URL, not a `github` provider with owner and repo compiled in. The app
// hands it to `autoUpdater.setFeedURL`, and `releases/latest/download` is the GitHub path
// that resolves to the newest published release's assets. Being a URL is what lets one
// wiring serve a packaged build and a development one, and what lets the address be shown.
export const defaultUpdateFeedUrl = 'https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download';
export const updateFeedUrlPattern = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})\/[A-Za-z0-9._-]{1,100}\/releases\/latest\/download$/;
export const UpdateFeedUrlSchema = z.string().regex(updateFeedUrlPattern).brand<'UpdateFeedUrl'>();
export type UpdateFeedUrl = z.infer<typeof UpdateFeedUrlSchema>;

/**
 * Accepts the feed address a person pastes, and returns the canonical form.
 *
 * A URL is required. Only `github.com` and only the `releases/latest/download` shape is
 * honoured, because the generic provider resolves `latest.yml` against whatever base it is
 * given, and a base that points anywhere else would fetch and run whatever it found there.
 * The trailing slash is normalised so `/releases/latest/download` and `.../download/` are
 * the same feed rather than two.
 */
export function parseUpdateFeedUrl(input: string): UpdateFeedUrl | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  // `URL` collapses `..` while parsing, so a traversal is already applied to `pathname` by
  // the time it is readable. A real GitHub owner or name is never `.` or `..`, so the raw
  // text is the only place the attempt is still visible.
  const raw = input.trim();
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(raw) || /%2e/i.test(raw) || raw.includes('\\')) return null;
  // An empty segment is refused rather than dropped: dropping `//name/...` would read
  // `name` as the owner, which is a different repository than the one pasted.
  const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const segments = pathname.split('/').slice(1);
  if (segments.some(segment => segment === '')) return null;
  if (segments.length !== 5) return null;
  if (segments[2] !== 'releases' || segments[3] !== 'latest' || segments[4] !== 'download') return null;
  const canonical = `https://github.com/${segments[0]}/${segments[1]}/releases/latest/download`;
  const parsed = UpdateFeedUrlSchema.safeParse(canonical);
  return parsed.success ? parsed.data : null;
}

export const ReleaseInfoSchema = z.object({
  version: z.string(),
  pageUrl: z.string().url(),
  notes: z.string(),
  publishedAt: z.number().int().nonnegative().nullable(),
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
  // electron-updater reports a percentage, not a byte count, and exposes no total, so the
  // progress bar is driven by the percentage alone.
  z.object({ kind: z.literal('downloading'), release: ReleaseInfoSchema, percent: z.number().nonnegative().max(100) }),
  z.object({ kind: z.literal('ready'), release: ReleaseInfoSchema, verifiedAt: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('installing'), release: ReleaseInfoSchema }),
  z.object({ kind: z.literal('failed'), reason: FailureReasonSchema, detail: z.string(), retry: RetrySchema, release: ReleaseInfoSchema.nullable() }),
]).readonly();
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const UpdateStatusSchema = z.object({
  currentVersion: z.string(),
  source: z.object({
    url: UpdateFeedUrlSchema,
    // A packaged build keeps its feed: the feed decides which installer this app will run,
    // and the binary is unsigned. A development build may point elsewhere.
    editable: z.boolean(),
  }).readonly(),
  preferences: z.object({
    // On by default: an updater nobody hears from is not one.
    autoCheckEnabled: z.boolean(),
    checkFrequency: z.enum(['hourly', 'daily', 'weekly']),
  }).readonly(),
  state: UpdateStateSchema,
  commands: z.array(UpdateCommandSchema).readonly(),
}).readonly();
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

/**
 * How often the background scheduler may ask GitHub. A preset rather than a free-form
 * number, so a tampered value cannot drive it to something sub-minimum.
 */
export const checkFrequencies = ['hourly', 'daily', 'weekly'] as const;
export const CheckFrequencySchema = z.enum(checkFrequencies);
export type CheckFrequency = z.infer<typeof CheckFrequencySchema>;

export type DesktopUpdateBridge = Readonly<{
  get(): Promise<UpdateStatus>;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  install(): Promise<UpdateStatus>;
  /** Refused in an installed build, which keeps its feed fixed. */
  setSource(url: string): Promise<UpdateStatus>;
  setPreferences(value: { autoCheckEnabled?: boolean; checkFrequency?: CheckFrequency }): Promise<UpdateStatus>;
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

// The releases page a reader can open for a feed address. Shown and linked in settings,
// because the address the app polls is not something a person should have to read as a
// raw `/releases/latest/download` path.
export function releasesPageUrl(feed: string): string {
  return String(feed).replace(/\/releases\/latest\/download\/?$/, '/releases');
}

export function releaseTagUrl(feed: string, version: string): string {
  return `${releasesPageUrl(feed)}/tag/${encodeURIComponent(`v${version}`)}`;
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
      return `Downloading Sunday Room ${state.release.version}: ${state.percent}%.`;
    case 'ready':
      return `Sunday Room ${state.release.version} is downloaded. Installing restarts Sunday Room.`;
    case 'installing':
      return `Installing Sunday Room ${state.release.version}. Sunday Room will close.`;
    case 'failed':
      return `${failureLine[state.reason]} ${state.detail}`.trim();
  }
}
