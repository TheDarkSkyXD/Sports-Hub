# Code style

Use these conventions when making relevant code or UI changes. Add future coding conventions to this document.

## UI interactions

- Preserve existing focus and visibility rules when adding controls to another renderer. Verify that changing focus removes controls from the previous item.
- Show pending automatic recovery instead of a manual failure prompt. Keep error and recovery messages outside idle cursor-hiding rules.
- Defer optional panels without changing the lifetime of unsaved form state. Preserve drafts across tab switches until the containing dialog closes.

## Dates and times

- Compare relative dates by calendar day in the displayed time zone.
- Show "Today" or "Tomorrow" with the start time for events on those days. Show the date and time for other events.

## Source parsing and player addresses

- Admit a published player only through an explicit provider host and path shape. A missing matchup in a URL does not make an arbitrary address compatible.
- Verify source rules against real captured positive cases and rejected unrelated addresses in both the native collector and playback adapter.
- Fixture capture must fail when required markup is missing. Do not convert an absent selector result into page text.
- Verify player visibility through its ancestors, including opacity and clipping. An element's own size does not establish its visible area.
- Admit media discovered in generic static iframes only after selected browser ownership is proven.
- Retire a reassigned feed through its previous event and game ownership. A shared player address alone does not establish that a feed moved.
- Use parsed event times in source identity when available. Formatting changes in the original clock text must not invalidate the same event.
- Refresh eligible published players before their retained publication expires. Recompute saved polling deadlines when game eligibility changes.
- Keep temporary schedule freshness separate from collected source publications. Pause checks on stale schedules without deleting events already found by the collector.

## Native lifecycle

- Keep requested playback state separate from observed media state. Recover unrequested interruptions without overriding explicit pauses, picture-in-picture controls, or ended media.

- Apply requested native-player bounds and visibility before navigation. Selected-frame ownership checks need a laid-out document during loading.
- Capture native object identities before registering destruction callbacks. Do not retrieve a child handle from its destroyed parent.
- Recheck host identity after asynchronous authorization and before allocating owned resources. Dispose partial allocations when setup fails.
- Bound process-lifetime browser contexts. Reuse them only after connection, authentication, storage, worker and cache cleanup completes; quarantine failed cleanup.
- Complete asynchronous shutdown work before final process-exit events. A callback cannot keep an exiting native process alive.
- Match cleanup to the resource's full lifecycle. Request upload completion does not establish response completion.
- Grant UI capabilities only to registered host roles at their current main-frame origin, and revoke them with the registration.
- Keep window capability registration independent of optional background services.

## Background verification

- Run maintenance checks in separate playback sessions. Preserve the active viewer's selected feed and generation.
- Keep working-feed maintenance intervals separate from failed-feed and incomplete-check retries.
- Finish available feeds' first attempts for today before tomorrow, and interleave due current-day failed or incomplete retries fairly with new attempts. Rechecks of working feeds follow today's first attempts and can run before tomorrow's. Future-day automatic retries follow first attempts. Capacity and cancellation do not complete a first attempt. Include every sibling from each source, and preserve explicit retry requests.
- Preserve completed feed-check outcomes across restarts, separately from working-video proof. Restore them only for a currently published route with matching game ownership. Active and queued work do not establish a completed attempt.
- Retry temporary viewer connection failures within the player startup deadline. Keep connection recovery separate from feed-verification status.
- Let the active media library manage automatic live synchronization. Do not seek ahead of downloaded video from a periodic UI timer.
- Keep optional fallback setup out of direct playback startup. Share one startup deadline across attempts, and allow bounded later recovery only after video has played.
- Separate the no-progress cutoff from the playback-proof deadline. Let advancing video finish its proof within the original deadline without reloading it. Expire verification attempts with no decoded progress as temporary deferrals.
- Route terminal player outcomes through the viewer's recovery owner. Keep local capacity and cancellation separate from feed failure, and verify the caller and player together.
- Preserve failure causes when adapting provider errors into check results. Verify the reported cause through the consuming inventory.
- Classify aborted operations from their signal's cause so timeouts and cancellations keep their retry behavior.
- Read stable persisted inputs once per synchronous planning pass. Take a new snapshot for the next pass instead of caching across asynchronous updates.
- Count verified feeds by the identity used for checks. Source labels and aliases do not establish additional working feeds.
- Keep transient upstream player sessions free of HTTP media caches. Bound browser verification separately from the number of discovered feeds.

