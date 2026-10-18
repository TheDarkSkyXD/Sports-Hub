# Electron performance and hostile-feed isolation

Research date: October 14, 2026. This is a source review and implementation recommendation, not a new runtime verification result. Local references describe the checkout inspected during research. See the [media checker audit](media-checker-audit-2026-10-14.md) for the earlier native evidence and its limits.

## Recommended order

1. Close application-wide download, permission, popup, and dialog gaps. Apply the restrictions before any source or room page loads.
2. Upgrade Electron within the current major release and repeat native isolation and playback checks.
3. Restrict the updater's actual requests and artifact metadata to this repository's GitHub release path. Disable unused web installers.
4. Measure a fixed acquisition workload before changing process reuse, checker concurrency, or background rendering.

Direct API or HTTP extraction should remain the first choice. Treat responses as data. Never evaluate downloaded JavaScript in Node, the main process, or a Node worker. Use the existing sandboxed Chromium capture only when the source actually needs browser execution.

## What isolation means here

An HTTP response and its HTML can be parsed without executing the site's scripts. A browser fallback executes scripts on the user's machine inside Chromium. Electron's renderer sandbox restricts operating-system access, but does not provide immunity to browser or sandbox vulnerabilities. Moving the same capture into a Node worker or a normal child process does not provide that sandbox. Electron's Node utility process also has Node integration. An off-machine acquisition service would be a separate deployment and trust decision. [Renderer sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox), [Node utility process](https://www.electronjs.org/docs/latest/api/utility-process).

The existing app already separates these roles:

| Role | Current local behavior | Keep or change |
| --- | --- | --- |
| HTTP resolution | Provider adapters, Rust collector, and public-page requests parse bounded remote responses | Prefer these paths. Return validated media or player metadata, never executable source code. |
| Browser capture | `sportsurge-observer.cjs`, both catalog collectors, and `source-page-reader.cjs` use sandboxed, isolated renderers with Node disabled | Keep the renderers without a preload bridge. Keep source scripts out of privileged processes. |
| Iframe playback | `isolated-player.cjs` creates a sandboxed `WebContentsView` without Node or a preload, bound to an opaque player capability | Keep selected-player ancestry, host/generation authorization, and explicit lifecycle cleanup. |
| Application UI | `main.cjs` loads the loopback application and exposes narrow preload methods | Keep sender, main-frame, origin, argument, and capability validation. Close the popup and session-policy gaps below. |
| Local server | `local-server.cjs` launches a separate Node server through `ELECTRON_RUN_AS_NODE=1`; collector work also uses Node worker threads | This separates workload and failures, but it is privileged local code. It must never execute remote scripts. |

Electron recommends Node disabled for remote content, context isolation, renderer sandboxing, maintained web security, restricted navigation, and sender validation. The current feed renderers satisfy those configuration requirements. No reviewed path needs disabled CSP, certificate acceptance, mixed-content permission, or an unrestricted preload. [Security checklist](https://www.electronjs.org/docs/latest/tutorial/security/).

Fetching video necessarily transfers media bytes. Blocking file downloads means preventing sites from saving a file or launching another application. It does not mean preventing all network transfers, Chromium buffers, transient storage, or the application's own logs and settings.

## Concrete safety gaps

| Priority | Evidence in the inspected checkout | Small change and proof |
| --- | --- | --- |
| High | `main.cjs` sends every HTTPS popup to `shell.openExternal`. Source windows deny popups, but the application window still has a broad OS handoff. | Deny arbitrary popup handoff. If a release-notes link is retained, admit only an application-owned action and the exact repository release URL. A native hostile nested frame must cause zero shell calls for HTTPS, custom protocol, file, and encoded URL attempts. |
| High | Source readers, collectors, and isolated players register `will-download`; room/default and verifier sessions do not. Observed-media sessions are net-only today and also lack this deny. | Install an idempotent download deny for all existing and future sessions, including `session-created`, before use. Cover attachment navigation, `<a download>`, blob/data URLs, scripted download, and iframe requests. Verify no save dialog or created artifact. |
| High | Remote sessions deny permission checks and requests; the main/default and verifier session setup lacks the same explicit policy. | Deny both checks and requests on every browsing session, with no permissive fallback for unknown permissions. Exercise filesystem, capture, notifications, clipboard, and device requests. |
| Medium | Hostile `BrowserWindow` and `WebContentsView` preferences do not set `disableDialogs`. | Set `disableDialogs:true` for source/capture/player roles. Verify alert/confirm/prompt attempts neither display a dialog nor stall cancellation or teardown. |

Electron provides a session-creation event for future-session coverage. Downloads can be canceled before they begin through `will-download`. Both permission handlers are needed for complete permission handling. Keep the policy separate from per-job `webRequest` handlers so installing one cannot replace the other. [App session events](https://www.electronjs.org/docs/latest/api/app#event-session-created), [Session controls](https://www.electronjs.org/docs/latest/api/session).

Dialog suppression is an explicit preference, with a false default. Blocking main-frame navigation alone does not cover iframe navigation. The existing selected-frame network admission remains necessary even when popup and download policies are global. [Web preferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences), [Navigation events](https://www.electronjs.org/docs/latest/api/web-contents#navigation-events).

Keep the current DNS pinning, all-answer public-address checks, authenticated proxy, WebRTC non-proxied UDP restriction, ad filtering, finite capture budgets, rolling playback budgets, and session cleanup. They address different risks. An ad list alone cannot establish machine isolation or correct event ownership.

## Electron maintenance

Installed Electron is **44.4.3**, with Chromium 152.0.7977.130. The official release index lists **44.7.2** as the latest stable on October 14, with Chromium 152.0.7977.149. Its release notes include upstream ANGLE, Chromium, PDFium, and V8 fixes. This provides a concrete reason for a same-major maintenance upgrade. Do not select Electron 45 beta for this work. [Installed-version release](https://releases.electronjs.org/release/v44.4.3), [Current stable release](https://releases.electronjs.org/release/v44.7.2), [Release index](https://releases.electronjs.org/).

Electron supports the latest three stable majors and only the latest minor within each supported series. Being on major 44 is insufficient if fixes land on a newer 44 minor. [Support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines#version-support-policy).

After changing the dependency, inspect the installed runtime version, rebuild the native collector, then exercise source capture, progressive replay, iframe playback, WebRTC restrictions, download prevention, cancellation, and the packaged application. A changed package range alone is not proof that the running app uses the new engine.

## The updater is a separate privileged downloader

`update.cjs` fixes packaged builds to `TheDarkSkyXD/Sports-Hub/releases/latest/download`. Development builds cannot download or install updates. `main.cjs` disables automatic downloads, and IPC checks the trusted application main frame. Preserve these protections.

Installed `electron-updater` is **6.8.9**. Its generic provider resolves artifact URLs from update metadata, including absolute URLs. Therefore, fixing the metadata feed does not by itself restrict every downloaded artifact to GitHub. Validate the repository's release artifact paths and restrict the updater session's initial and redirected requests. Retain the exact GitHub asset redirect hosts required by observed release downloads; a blanket GitHub-domain suffix rule is too broad. [6.8.9 generic provider](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.9/packages/electron-updater/src/providers/GenericProvider.ts), [6.8.9 artifact resolution](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.9/packages/electron-updater/src/providers/Provider.ts).

Set `disableWebInstaller=true`: this application packages a full NSIS installer. In 6.8.9, a supplied web package can otherwise cause a second payload download. Test rejection of foreign absolute artifact URLs, protocol changes, foreign redirects, and companion packages before any request or write. Keep a positive test for the genuine repository release and its asset redirect. [6.8.9 NSIS downloader](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.9/packages/electron-updater/src/NsisUpdater.ts).

The updater uses its own `electron-updater` session and `net.request`, streaming bytes to its chosen update cache. This differs from a browser `DownloadItem`. A global browser-download deny should coexist with an independently restricted updater request policy. Verify both against the installed implementation. [6.8.9 HTTP executor](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.9/packages/electron-updater/src/electronHttpExecutor.ts).

Current comments state that installers are unsigned. The installed NSIS updater skips publisher verification when `publisherName` is absent. A checksum detects a mismatch against the manifest; it does not authenticate a manifest and payload replaced together. Record this remaining release-trust risk. Code signing or signed update metadata needs a separately managed signing identity and release-key policy. New electron-builder 27 documentation describes signed manifests, but that behavior must not be attributed to installed builder 26.15.3/updater 6.8.9. [Installed NSIS verification](https://github.com/electron-userland/electron-builder/blob/electron-updater%406.8.9/packages/electron-updater/src/NsisUpdater.ts), [Signed-manifest design](https://www.electron.build/docs/features/signed-update-manifests/).

## Performance choices supported by evidence

Electron's advice is to profile, avoid blocking privileged/UI threads, defer unnecessary startup work, avoid needless network dependencies, and inspect module costs. The prior native profile found main and room JavaScript roughly 97% idle. Its incomplete trials occupied slots for 20 to 55 seconds, with substantial renderer turnover. Those measurements support acquisition and lifecycle work ahead of a broad bundling or worker rewrite. [Official performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance).

Keep four physical checker jobs, direct HTTP before capture, dormant fallback, revision-cached inventory, small verifier buffers, and bounded clean-session reuse. Preserve a user's visible playback under background checking. Prefer a documented provider API when it supplies event-bound media without running its advertising page.

Next, replay fixed source fixtures and measure browser creation, document readiness, ownership selection, first media response, decode proof, cleanup, and queue time separately. Count completed and deferred jobs, not only published feed changes. Compare cold and warm runs with the same active player and concurrency. Keep CPU from departed processes and distinguish private memory from summed working sets. The old development profiles cannot establish a total CPU or memory reduction.

Every current browser role disables `backgroundThrottling`. Electron documents that one such view keeps the owning window drawing frames. Hidden proof windows need advancing video, so restoring throttling globally risks false timeouts. A later measured change can allow throttling for an idle room while preserving background playback and capture deadlines. Prove minimized playback, hidden proof, and dialog-covered players before adopting it. [Background throttling behavior](https://www.electronjs.org/docs/latest/api/structures/web-preferences#webpreferences-object).

The default native menu can be omitted before readiness when the product needs none. This app hides its menu rather than replacing it; first account for edit, reload, and accessibility shortcuts. That is a small startup experiment, not evidence of the current feed bottleneck. Avoid disabling GPU acceleration, renderer isolation, sandboxing, web security, or certificate checks as performance tweaks.

## Fuses and packaging

Do not disable `RunAsNode` in the current architecture: packaged server startup requires it. Migrating trusted server startup to `utilityProcess` would be an architectural change, not a feed sandbox. Release-only candidates are disabling Node inspector arguments, unused Node environment options, and extra `file://` privileges. Keep development inspection available. Enabling ASAR integrity and ASAR-only bootstrap requires packaged validation; the external server and native addon remain outside that archive and need their own release integrity. Fuses do not authenticate an unsigned installer or remove Node privileges from the server. [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), [ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity).

No cookie-encryption migration, custom V8 snapshot, experimental renderer flag, or process-model rewrite is justified by this acquisition task. Temporary source sessions already avoid a persistent browser profile. Keep any new policy focused and verify it against the actual packaged app before claiming it protects installed users.
