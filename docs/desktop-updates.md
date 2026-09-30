# Desktop updates

How the installed Windows app finds a new build, and what it refuses to trust. This
records the decisions behind `desktop/update.cjs` so a later change does not quietly undo
one of them.

## The check

The app is built on `electron-updater`. `desktop/main.cjs` constructs an `NsisUpdater` and
`desktop/update.cjs` wires its events to the state machine the UI already speaks, so the
library owns the transfer and the checksum while this repo owns the vocabulary.

Two consequences worth knowing:

- **The feed is baked into the build.** electron-builder writes `resources/app-update.yml`
  from the `publish:` block in `electron-builder.yml`, and the library reads that. There is
  no runtime setting to change it.
- **A release must publish `latest.yml` and the blockmap.** Without them the library
  cannot resolve an update at all, and every installed copy stays where it is. The workflow
  uploads all three.

A downloaded installer is checked against the `sha512` in `latest.yml`. That proves the
bytes are the bytes the record names. It proves nothing about whether the release itself
was legitimate, because the binary is still unsigned.

## An installed app takes updates from one repository

The feed in `app-update.yml` is the only source an installed build will use. Nothing at
runtime can move it.

This is deliberate and it is the sharpest edge in the feature. The feed decides which
installer the app downloads and runs, and until the binary is signed there is no signature
to check that installer against. So anything that could rewrite that file would otherwise
choose what code this app runs next. That is worse than having no updater at all.

A development build *is* rewritable: `SUNDAY_ROOM_UPDATE_SOURCE` writes a `dev-app-update.yml`
on each launch, which is how the flow gets exercised against a fork before packaging. It
also means the library has to be told to run at all, which is what `forceDevUpdateConfig`
does — `isUpdaterActive` is false for an unpackaged app otherwise.

## Development builds never install

`electron-updater` works in a development build, so the settings panel and the popup are
fully exercisable before packaging. Download and install are still refused in
`desktop/update.cjs`, because those write to the machine and run an unsigned binary.

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
