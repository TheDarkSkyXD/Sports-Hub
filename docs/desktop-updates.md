# Desktop updates

How the installed Windows app finds a new build, and what it refuses to trust. This
records the decisions behind `desktop/update.cjs` so a later change does not quietly undo
one of them.

## The check

The app uses [StreamFusion's updater flow](https://github.com/TheDarkSkyXD/StreamFusion/blob/main/apps/desktop/src/backend/features/settings/adapters/electron/update-service.ts): a generic GitHub release feed,
manual downloads, and installation on quit. `desktop/main.cjs` constructs the
`DesktopNsisUpdater` adapter in `desktop/nsis-updater.cjs`.
`desktop/update.cjs` maps its events to the state machine the UI already uses. The library
owns the transfer and checksum check.

The feed is a **plain URL**, not a provider:

```
https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download
```

`desktop/main.cjs` hands it to `autoUpdater.setFeedURL` as a generic provider, which
resolves `latest.yml` against that base. `releases/latest/download` is the GitHub path
that always resolves to the newest published release's assets.

Being a URL rather than a baked `owner`/`repo` pair is what lets one wiring serve an
installed build and a development one, and what lets the address be shown and, in
development, changed. `electron-builder.yml` declares the same generic URL as its publish
provider so packaging emits `latest.yml`. The runtime `setFeedURL` call
selects the feed the app reads. `npm run desktop:package` passes `--publish never`, so
packaging does not upload any assets.

**A release must publish the installer and `latest.yml`.** Without `latest.yml`, the library
cannot resolve an update. The workflow uploads both files as one artifact, then attaches
them to the draft release. Differential downloads are disabled, so new builds do not
produce a blockmap. Older installed builds fall back to a full installer download when
the blockmap is absent.

A downloaded installer is checked against the `sha512` in `latest.yml`. That proves the
bytes are the bytes the record names. It proves nothing about whether the release itself
was legitimate, because the binary is still unsigned.

## An installed app takes updates from one address

The feed is fixed in an installed build. The settings field shows it read-only.

This is deliberate and it is the sharpest edge in the feature. The feed decides which
installer the app downloads and runs, and until the binary is signed there is no signature
to check that installer against. The generic provider will resolve `latest.yml` against
whatever base it is given, so a rewritable feed in a shipped app would let anything that
can write as the user choose what code this app runs next. That is worse than having no
updater at all.

Only `https://github.com/<owner>/<name>/releases/latest/download` is accepted, and only
where the development build can set it — anything with credentials, a port, a query, a
fragment, or a path that walks to another repository is refused.

A development build *is* rewritable, through `SUNDAY_ROOM_UPDATE_SOURCE` or the settings
field, which is how the flow gets exercised against a fork before packaging.

## How a release reaches someone

A background scheduler, not a startup-only check. `electron-updater` is asked at launch
when the interval has elapsed, and then every fifteen minutes to look — the interval
decides when to ask, the tick only decides when to look. `hourly`, `daily` (the default) or
`weekly`, with a one-hour floor so nothing can drive it below that.

StreamFusion checks once at startup when its saved interval has elapsed. Sunday Room also
checks while it stays open, so a release published during a long viewing session can appear
without a restart. The schedule is on by default and can be turned off in settings.

A failed automatic check restores the previous timestamp, so one bad network moment does
not block retries for a whole interval.

When a release is found and the window does not have focus, a **system notification** is
raised. The in-app popup only helps if the user happens to be looking at it, and a window
behind something else is not looking. Clicking it restores and focuses the window.

## Development builds never install

`electron-updater` skips every check when the app is not packaged unless
`forceDevUpdateConfig` is set. `desktop/main.cjs` sets it and points the feed at the same
URL, so a development build exercises the real updater — a supported path, not a bypass.

Download and install are still refused in `desktop/update.cjs`, because those write to the
machine and run an unsigned binary.

## The installer and its install directory

**Install and restart** opens a full-window updating page in Electron. The app waits
for that page to paint, then stops its streams, collectors, and local server before
starting the installer. The update service stays alive until Electron exits, so a
preparation or installer-launch failure stays visible with **Retry install**.

The upstream `NsisUpdater.quitAndInstall` starts the installer before calling
`app.quit`. Its synchronous return also precedes the result of the asynchronous
process launch. `DesktopNsisUpdater` keeps the upstream download and checksum path,
but awaits installer launch before quitting. Its launch arguments and elevation
fallback follow the bundled electron-updater implementation. Check this adapter
when upgrading electron-updater.

An explicit update passes `--updated`, `/S`, and `--force-run`. The NSIS
`customInit` hook makes that combination visible. The directory and install-mode
pages remain skipped, so the Windows window shows installation progress directly.
Electron must exit while Windows replaces its executable and resources.

After replacement, the installer launches the executable in `$INSTDIR` directly,
as the desktop user, and closes without a Finish click. It checks the shell launch
result and offers Retry if Windows rejects the launch. Restart does not depend on
the existing Start Menu shortcut.

Closing the app after a download still uses the ordinary silent update path. That
path does not force the app to reopen.

`electron-updater` declares `installDirectory` but never sets it, and without it the
installer runs without `/D=`. `desktop/main.cjs` sets it from `process.execPath`, which is
what lets `desktop/installer.nsh` restore the install directory instead of looking like a
fresh install on next launch.

The runtime checks are `tests/desktop-install-handoff.test.ts`,
`tests/nsis-updater.test.ts`, `tests/desktop-update-screen.electron.mjs`, and
`tests/installer-update.mjs`. The native installer check uses a temporary app
identity, custom install directory, and user-data marker. It does not update the
user's Sunday Room installation.

## Signing

Not done, and it is the real fix for everything above.

`electron-builder.yml` reads signing configuration from the environment, so wiring it in
did not require code. A signed build needs, on the machine or in the Actions runner:

| Variable | What it is |
| --- | --- |
| `CSC_LINK` | Path to the `.pfx`, or the base64 of the `.pfx` as a secret |
| `CSC_KEY_PASSWORD` | The password for that `.pfx` |

With both set, the installer and the app executable are signed. Without them,
electron-builder prints a warning and ships unsigned, which is the current state.

Once signed, verify the downloaded installer's signature before running it, and add that
check to `desktop/update.cjs`. Until then, keep the source pinned.

The private key must never be committed, and should not sit on a developer machine that
also builds untrusted code.
