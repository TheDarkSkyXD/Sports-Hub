import { z } from 'zod';

// A maintainer changes the channel by editing this one constant. Nothing else in the
// app carries a repository name, and `SUNDAY_ROOM_UPDATE_SOURCE` only wins when the
// app is not packaged, so a stray variable cannot redirect the feed in a shipped build.
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

// `owner/name`, never a URL. electron-builder bakes the feed into the build as
// `app-update.yml`, and the addresses below are derived from the slug for display, so
// nothing a person can type or paste can point the updater at an arbitrary host.
export const releaseRepoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const ReleaseRepoSchema = z.string().regex(releaseRepoPattern).brand<'ReleaseRepo'>();
export type ReleaseRepo = z.infer<typeof ReleaseRepoSchema>;

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
  z.object({ kind: z.literal('downloading'), release: ReleaseInfoSchema, percent: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('ready'), release: ReleaseInfoSchema, verifiedAt: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('installing'), release: ReleaseInfoSchema }),
  z.object({ kind: z.literal('failed'), reason: FailureReasonSchema, detail: z.string(), retry: RetrySchema, release: ReleaseInfoSchema.nullable() }),
]).readonly();
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const UpdateStatusSchema = z.object({
  currentVersion: z.string(),
  source: z.object({
    repo: ReleaseRepoSchema,
    origin: z.enum(['packaged', 'file', 'environment']),
  }).readonly(),
  state: UpdateStateSchema,
  commands: z.array(UpdateCommandSchema).readonly(),
}).readonly();
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export type DesktopUpdateBridge = Readonly<{
  get(): Promise<UpdateStatus>;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  install(): Promise<UpdateStatus>;
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

// The updater's own config, not a field a person can edit. `parseReleaseSource` still
// accepts what someone might paste, because the address is worth showing and worth
// checking, but the feed itself is fixed when the build is packaged.
export function releaseFeedUrl(repo: string): string {
  // The releases page rather than the raw API document: this address is shown to a person,
  // and it is what the settings panel links to.
  return `https://github.com/${repo}/releases`;
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
      return `Downloading Sunday Room ${state.release.version}: ${state.percent}%.`;
    case 'ready':
      return `Sunday Room ${state.release.version} is downloaded. Installing restarts Sunday Room.`;
    case 'installing':
      return `Installing Sunday Room ${state.release.version}. Sunday Room will close.`;
    case 'failed':
      return `${failureLine[state.reason]} ${state.detail}`.trim();
  }
}
