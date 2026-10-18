# Feed acquisition, Electron isolation, and performance

This follow-up implements the authorized fixes after the [media checker audit](media-checker-audit-2026-10-14.md). It covers local source acquisition, the trusted watch room, isolated players, update transport, and source APIs. It preserves direct video first and an isolated selected-player fallback.

The implementation follows the [official Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security/), [sandbox guidance](https://www.electronjs.org/docs/latest/tutorial/sandbox), and [performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance). The supporting investigations are [Electron performance and security](electron-performance-security-2026-10-14.md) and the [source API review](source-api-review-2026-10-14.md).

## What protects the machine

Source HTML and JSON are parsed as data. Downloaded source JavaScript does not run inside the privileged Node collector. When a provider requires browser execution, it runs in a separate sandboxed Chromium renderer with context isolation and no Node or application bridge. Browser acquisition and isolated playback retain their role-specific public-network, navigation, ad-blocking, ownership, and cleanup rules.

A global policy now covers the default session, existing acquisition and verification roles, and future sessions. It cancels browser downloads before a file can be saved. It denies location, camera, microphone, device, display capture, clipboard read, and other unsolicited permissions. New web contents deny popups and webview attachment. Hostile page constructors disable JavaScript dialogs.

The trusted viewing window has two narrow exceptions. A user gesture can request fullscreen, and its main frame can write sanitized clipboard text. The grant binds the exact web contents and current local origin. Main-window registration is independent of optional source-observer startup. Verification hosts, remote pages, child frames, and automatic fullscreen remain denied. Closing or stopping the owner revokes its grant.

Arbitrary feed links no longer reach `shell.openExternal`. Project and release links use a strict selected GitHub repository rule. Source, server, and RedZone inspection controls explicitly copy their addresses instead. They show copy success or failure and do not launch a browser.

This is local containment. Chromium still fetches media and sometimes executes provider scripts on the user's machine, inside its sandbox. A local script or Node worker cannot make that execution happen off the machine. Off-device acquisition would require a separate hosted service. These controls reduce exposure; they do not establish immunity to an unknown Chromium or operating-system exploit.

## Provider requests use one public-network boundary

Some existing provider fast paths used ordinary `fetch`, bypassing the public-address transport already used by generic extraction. They now use a shared pinned HTTPS transport. It rejects private, reserved, malformed, and unsupported destinations before opening the provider socket. DNS answers are validated and the selected public address is pinned to the request. Redirects remain explicit and bounded by their callers.

The transport owns its keep-alive agent. Node 24's environment-proxy behavior must not silently redirect an admitted public request through an unrelated local proxy. A child-process test reproduced that bypass with the global agent; the owned agent prevents it. TLS validation remains enabled.

Request cancellation reaches the real socket and response body. Gzip, deflate, and Brotli responses have limits on both compressed and inflated bytes. Existing direct progressive replay retains its separate bounded streaming policy. No checker concurrency increase or new application-level connection queue was added.

Manual URLs entered by the user are a separate existing feature. They play through `GamePlayer` and Hls.js in the trusted room, rather than the provider-pinned transport. Manual input still accepts HTTPS and explicit HTTP loopback addresses. A manual playlist can refer to other HTTP or HTTPS media destinations, as it could before this change. Public-DNS isolation claims in this report apply to collected provider traffic, not every manual playlist request.

## The trusted room rejects injected scripts

Each app document receives a fresh nonce in the request and response Content Security Policy. Framework scripts carry that nonce. Production uses `strict-dynamic` without `unsafe-inline` or `unsafe-eval` for scripts. The policy denies frames, objects, base elements, and embedding of the room. API, media, and static responses avoid per-document nonce processing.

The room allows HTTP and HTTPS media and connections to preserve manual feeds, including IPv6 loopback. [CSP host matching does not support IPv6 literals](https://www.w3.org/TR/CSP/#match-hosts), so a hostname-only loopback list broke a supported input. This policy prevents script injection; it is not the provider outbound-address filter.

The native verification uses a matched parser-inserted payload. Its harmless script executes in the control document without a policy and is blocked under the actual server policy. Nonce-authorized code and real Next hydration work in both documents. Debugger-inserted scripts bypass CSP and were discarded as injection evidence. The correction is recorded in the decision trail.

## Only admitted updates can save an installer

Browser file downloads remain denied, including in the updater session. The updater uses a separate `net.request` transport to write its own cache; it does not need a browser-download exception.

The update executor admits the selected GitHub repository's `latest.yml` and one full Windows x64 installer with its exact versioned filename and canonical SHA512. It rejects foreign absolute URLs, alternate protocols, conflicting metadata, companion packages, web installers, and direct CDN requests. A release CDN URL is accepted only as a bounded continuation of an admitted GitHub redirect. Changing the selected feed revokes outstanding grants.

Cached installers must have the exact admitted basename and metadata, remain inside the real cache directory, be regular non-symlink files, and match a freshly computed SHA512. Installation repeats that validation. Differential and web-installer paths are disabled so they cannot introduce a second payload.

Native testing found an Electron event-order bug in the first implementation. A request emits upload `close` before `onBeforeRequest`; removing its grant there blocked valid GitHub metadata. Cleanup now follows response completion, response failure, request abort, or request failure. A real metadata request fetched release 1.0.12 through three expected requests. Unrelated-site, foreign-repository, and direct-CDN requests were rejected before `net.request` ran. No installer was downloaded or executed during this audit.

Ordinary quit now holds an earlier `before-quit` event while installer validation and launch acknowledgement complete. It respects the application's preceding asynchronous shutdown work. Repeated quits cannot bypass an in-flight installation, and a failed launch resets the state for retry. The old final `quit` callback could exit before asynchronous validation reached the launch.

The releases remain unsigned. GitHub origin, TLS, and SHA512 do not authenticate a publisher if the repository and manifest are compromised together. Code signing needs a real signing identity and release-key policy. No identity was invented or certificate installed. The release-trust limitation remains open.

"No site downloads" means no site-triggered file save or native executable handoff. Playing video still transfers media bytes. The browser also uses transient state, and the app writes its own logs and update cache.

## Source APIs replace unnecessary HTML

The source review covers 129 registry rows across 21 source families. Ten registry rows already used JSON acquisition before this change. The [source API report](source-api-review-2026-10-14.md) records the observed contracts and which sources have no verified supported API.

| Source | Implemented acquisition | Identity rule and measured payload |
| --- | --- | --- |
| Streamcenter | Documented anonymous match and stream APIs | Exact ESPN league and event ID, advertised source group, selected UUID, watch URL, and player host/path must agree. A football catalog response was 1,751 bytes versus 33,855 bytes of HTML. A player response was 256 bytes. |
| Dudestream | WordPress category and posts REST endpoints with selected fields | Category, canonical post URL, duplicates, and pagination are checked. Detail-player admission remains. The narrow category response was 36 bytes and a seven-post response was 938 bytes versus 805,769 bytes of category HTML. |

The Dudestream numbers describe two API responses and one HTML response. They establish reduced input bytes, not a measured end-to-end latency improvement. Post publication dates never become game kickoff times. Pagination is bounded and truncated catalogs fail instead of silently losing events.

An authoritative API failure does not reopen stale category HTML through browser recovery. Missing or conflicting Streamcenter event and player identities fail closed. Its unused HTML listing parser was deleted. Detail compatibility remains because persisted observations still reach that path after a restart; playback revalidates the selected UUID through the API.

Streamed's existing documented API remains in use. An API that supplies an event-bound embed still requires isolated playback or media extraction; it does not imply a direct video URL. No undocumented API was invented for the other sources.

## Performance decisions

The earlier native profile found main and room JavaScript roughly 97 percent idle, while incomplete capture trials occupied checker slots for 20 to 55 seconds. That supports reducing acquisition work and browser churn before rewriting UI state or increasing parallelism.

This work preserves the earlier four physical checker jobs, eight bounded clean isolated-player sessions, direct HTTP preference, dormant iframe fallback, small verification buffers, progressive replay, revision-cached inventory, and selected-player cleanup. Acquisition uses its own observer and source roles. The new APIs avoid large advertising pages when a verified data endpoint is available. The shared public HTTP agent retains keep-alive reuse with bounded idle sockets.

Electron was patched from 44.4.3 to 44.7.2. Next and related security-sensitive parser and image dependencies were updated. The runtime dependency audit reports no known vulnerabilities. That result is a dependency-database check, not a proof of absence of vulnerabilities.

No overall CPU, memory, startup, or capture-latency reduction is claimed. A controlled comparison would need the same source responses, visible player, cold or warm state, and concurrency. Raising concurrency, disabling sandboxing, disabling GPU acceleration, or weakening TLS was not justified. Hidden proof windows still need advancing media; globally restoring background throttling would invalidate that work.

The compiled app exposed a Next upgrade compatibility issue. A generated Sharp alias now points at the owned standalone package tree. Preparation accepts that owned target in addition to the source tree, keeps the package allowlist and realpath checks, rejects outside aliases, and materializes independent copies. Both the focused packaging tests and actual compiled server pass.

## Verification and limits

The final full Node suite has 1,359 passing tests, no failures, and one Windows privilege-dependent symlink test skipped. All 55 Rust tests pass. Lint and typecheck pass. The compiled Electron app uses the updated runtime and native collector.

Native checks prove that default, verification, and future sessions block file downloads and unsolicited permissions. Untrusted pages have no Node or application bridges or clipboard access. The trusted room can write sanitized clipboard text but cannot read it. No files were saved and no untrusted external browser was launched.

The actual compiled document passes nonce, injection-control, hydration, and HTTPS, IPv4, and IPv6 manual-video checks. The managed player passes direct decode, isolated decode, pause and resume, volume and mute, dialog visibility, user-gesture fullscreen, source switching, removal, late-proof rejection, and retry checks. Seventy-five source and RedZone copy controls produced exact expected addresses and confirmation with the real clipboard left untouched. Server copy controls have component coverage; current native inventory data did not expose a server copy control.

The real ordinary-quit canary passes. It intercepts launch of an inert local fixture, delays acknowledgement, observes acknowledgement before final quit, and confirms that the actual app process exits. No executable runs. The first canary recorded final quit before launch acknowledgement, but its attached inspector held the process open. That earlier process-exit timing is not claimed as valid evidence. The corrected verifier disconnects before observing exit.

Final review found that main-window permissions depended on optional observer startup. Two failing main-entry tests reproduced the startup and later-stop cases. Independent window registration fixes both. A native startup-failure fixture confirms that the room still hydrates, fullscreen works with a user gesture, clipboard write is granted, and clipboard read stays denied. The normal app was then restored. The final readiness check confirms one current Electron 44.7.2 app, the latest main-file hash, a hydrated empty watch room, and a successful source API response with 129 rows. Its server remains running for the user.

The checks do not install a packaged NSIS release, prove all provider embeds, guarantee that every source is ad-free, bypass DRM, or establish visual event identity. The earlier PPV upstream failures and Streamcenter historical-footage observation remain provider limitations. The app must retain those uncertainty states rather than label a decoded video as verified event footage.

The local decision trail and rerunnable evidence are in `.desktop-runtime/feed-isolation/`. The task delta is measured against the follow-up baseline, preserving the checkout's pre-existing edits. No production service, database, release channel, PR, or commit was changed.
