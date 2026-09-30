# Desktop updates

How the installed Windows app finds a new build, and what it refuses to trust. This
records the decisions behind `desktop/update.cjs` so a later change does not quietly undo
one of them.

## The check

The app is built on `electron-updater`. `desktop/main.cjs` constructs an `NsisUpdater` and
`desktop/update.cjs` wires its events to the state machine the UI already speaks, so the
library owns the transfer and the checksum while this repo owns the vocabulary.

The feed is a **plain URL**, not a provider:

```
https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download
```

`desktop/main.cjs` hands it to `autoUpdater.setFeedURL` as a generic provider, which
resolves `latest.yml` against that base. `releases/latest/download` is the GitHub path
that always resolves to the newest published release's assets.

Being a URL rather than a baked `owner`/`repo` pair is what lets one wiring serve an
installed build and a development one, and what lets the address be shown and, in
development, changed. It also means nothing needs `resources/app-update.yml`;
electron-builder infers a `github` config from the git remote and writes one anyway, but
`setFeedURL` replaces the provider, so it is inert. The packaged app was verified starting
with that file renamed away.

**A release must publish `latest.yml` and the blockmap.** Without them the library cannot
resolve an update at all, and every installed copy stays where it is. The workflow uploads
all three. A release published before this has none, so it is invisible until the next one.

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

StreamFusion checks once at startup and never polls. That is right when the app is short-lived
and wrong for a viewer someone leaves open all day: a release published that morning would
not be mentioned until the next launch. The schedule is on by default and toggleable in
settings, because an updater nobody hears from is not one.

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

`electron-updater` declares `installDirectory` but never sets it, and without it the
installer runs without `/D=`. `desktop/main.cjs` sets it from `process.execPath`, which is
what lets `desktop/installer.nsh` restore the install directory instead of looking like a
fresh install on next launch.

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
