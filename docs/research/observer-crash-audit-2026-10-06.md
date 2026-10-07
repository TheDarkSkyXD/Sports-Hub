# Observer crash and desktop shutdown audit

The user reported a main-process `TypeError: Cannot read properties of null (reading 'url')` at `desktop/sportsurge-observer.cjs:542:86`. The actual local Electron 44.4.3 process also had a hidden main window and an Error dialog.

Electron's native `FramesInSubtree()` collects render-frame hosts without excluding hosts pending deletion. Conversion through `WebFrameMain::From()` returns null for a host ready for deletion, so JavaScript can receive null entries despite the declared `WebFrameMain[]` type. The observer's half-second player timer dereferenced each entry outside its frame-acquisition catch. The same assumption appeared in the asynchronous media probe and StreamEast selected-frame uniqueness scan. The exact provider navigation that produced the user's deleted frame is unknown. [Pinned Electron implementation](https://github.com/electron/electron/blob/v44.4.3/shell/browser/api/electron_api_web_frame_main.cc#L512-L521).

One private `liveFramesInSubtree` boundary now removes null and destroyed frame handles before those three scans. Retained objects preserve player identity and strict uniqueness. Existing frame limits and ownership checks after asynchronous work remain intact. A disposed native tree ends a media probe through narrowly scoped acquisition handling.

The new timer regression failed before the fix. A real Electron reproduction injected null and destroyed siblings beside a native player frame. The original module raised the identical exception at the same timer stack. The fixed module activated that surviving native player once without the exception.

```text
TypeError: Cannot read properties of null (reading 'url')
{"surface":"Electron 44.4.3","verdict":"PASS","cycles":1,"activations":1}
```

Desktop lifecycle investigation found two additional defects. A second-instance launch restored minimized windows and focused them but did not show a hidden window. A cleanup failure aborted the remaining shutdown steps, and the normal quit rejection handler only logged the error. Closing the main window could therefore leave the single-instance owner, local server, and collectors running without a visible window.

Relaunch now shows the existing live window. Shutdown publishes one shared stopping promise before destructive work starts, attempts all five original resource operations in order, and reports all failures. Ordinary failed shutdown exits with code 1 after cleanup attempts. The actual NSIS quit handler skips automatic installation for that exit status. Successful close keeps its existing automatic-install behavior. Explicit install preparation still rejects failed cleanup while retaining its visible window.

The real Electron failure reproduction called the actual observer stop and then injected an exception. Before the fix, native window close removed the main window but left the main process and server/collector children running. After the fix, the same close terminated all 12 owned processes and returned exit code 1. A normal close of the fixed local app terminated all 11 owned processes and released the local server listener. A real second launch exited normally and changed the existing main window from hidden to visible.

The process census identified the current application tree as local development Electron, not an installed Sunday Room release. One older network utility had no living parent. It was terminated; its creation cause remains unknown. No executable-name cleanup or unrelated process termination was added to application code.

Regression coverage executes the actual observer callbacks and desktop entry point. It checks null/destroyed siblings, living-player activation, duplicate-player rejection, media discovery, disposed native trees, visible relaunch, repeated quit, multiple cleanup failures, explicit install preparation, and the actual NSIS quit handler. Independent review passed all 17 focused observer/lifecycle/install/updater tests with no blocking findings.

All 487 applicable tests, full ESLint, TypeScript, and the production build pass. The existing stale packaged-installer check remains excluded because its local artifact is version 1.0.6 and this project is version 1.0.10. No installer was built. The failing regressions were committed before the two production fixes.

The rebuilt local app reopened as process 70804 at `http://127.0.0.1:51931/`. Electron MCP inspected and captured the loaded viewing room, while native inspection confirmed the main window visible, responsive, and not minimized. A second launch exited with code 0 and raised the existing window. The app continues its automatic source checks with the corrected observer.
