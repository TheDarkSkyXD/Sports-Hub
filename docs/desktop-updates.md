# Desktop updates

How the installed Windows app finds a new build, and what it refuses to trust. This
records the decisions behind `desktop/update.cjs` so a later change does not quietly undo
one of them.

## The check

`desktop/update.cjs` reads `https://api.github.com/repos/<owner>/<name>/releases/latest`
directly. It is not built on `electron-updater`, and it does not read `latest.yml`, an
`app-update.yml`, or a blockmap.

A downloaded installer is accepted only if its byte count and `sha256` match what the
release itself publishes. That proves the bytes are the bytes GitHub published. It proves
nothing about whether the release was legitimate, because the binary is still unsigned.

## An installed app takes updates from one repository

`defaultReleaseRepo` in `lib/desktop-update.ts` is the only source an installed build will
use. Neither the settings field nor the `source` key in `update.json` can move it.

This is deliberate and it is the sharpest edge in the feature. The source decides which
installer the app downloads and runs, and until the binary is signed there is no signature
to check that installer against. So anything that can write as the user — the settings
field, a text editor, any other process on the machine — could otherwise choose what code
this app runs next. That is a remote code execution primitive handed to local malware, and
it is worse than having no updater at all.

A development build is free to point at another repository, because it refuses to download
and install anything. Point it somewhere with `SUNDAY_ROOM_UPDATE_SOURCE`, or edit the field,
to exercise the flow against a fork.

## The release workflow does not publish `latest.yml` or a blockmap

`electron-builder` writes both into `dist-electron/`, and the release job uploads only the
installer `.exe`. That is intentional, not an oversight.

Nothing in the app reads them. Publishing a manifest that no code consults invites a later
change to start trusting it, and `electron-updater`'s trust model is weaker than what is
already here: it resolves an update from a channel feed and diffs blocks, where this app
re-reads the release and pins the asset by name, size, and digest. Adding the files would
make the repository look like it supported a mechanism it does not use.

If the updater is ever rebuilt on `electron-updater`, this decision has to be revisited in
the same change that introduces it. Do not add the files on their own.

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
