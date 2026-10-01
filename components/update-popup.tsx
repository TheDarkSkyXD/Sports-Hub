'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, RotateCw, X } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { type DesktopUpdateBridge, type UpdateCommand, type UpdateStatus } from '@/lib/desktop-update';

const commandLabel:Record<UpdateCommand,{text:string;icon:typeof RefreshCw;primary:boolean}> = {
  check: {text:'Check updates',icon:RefreshCw,primary:false},
  download: {text:'Download update',icon:Download,primary:true},
  install: {text:'Install and restart',icon:RotateCw,primary:true},
};

// One button that walks the whole chain, the way the update control in a chat client does:
// press it while a release is available to download it, press it again once the bytes are
// verified to install them. Chaining the steps here means the user never has to know which
// of the two is currently applicable.
const advanceCommand = (state:UpdateStatus['state']):UpdateCommand => {
  if (state.kind === 'available') return 'download';
  if (state.kind === 'ready') return 'install';
  // A failure already names the step worth retrying, so the same button stays the retry.
  if (state.kind === 'failed' && state.retry) return state.retry;
  return 'check';
};

const DISMISSED = 'sunday-room:dismissed-update';

// Reads the same dismiss record the browser-side toast uses so dismissing in the
// installed app and dismissing in a browser tab cannot disagree within a session.
const dismissedVersion = ():string => { try { return localStorage.getItem(DISMISSED) ?? ''; } catch { return ''; } };

/**
 * Top-right update popup. Subscribes to the same bridge the settings panel uses, so
 * the two views can never disagree about what the updater is doing.
 *
 * Dismissal is recorded per version: a newer release re-opens the popup, the same
 * release stays closed even across restarts.
 */
export function UpdatePopup() {
  const [status,setStatus] = useState<UpdateStatus|null>(null);
  const [dismissed,setDismissed] = useState('');
  const [error,setError] = useState('');
  const api = useRef<DesktopUpdateBridge|null>(null);

  useEffect(()=>{
    // Read directly rather than from a prop: `app/page.tsx` sets its `desktop` flag in a
    // `window.setTimeout(..., 0)` effect, so a prop would flash "browser" for one frame.
    const bridge = typeof window === 'undefined' ? undefined : window.sundayDesktop;
    if (!bridge) return;
    api.current = bridge;
    const off = bridge.subscribe(next => { if (bridge === window.sundayDesktop) setStatus(next); });
    // `get` exists so the popup can appear on the first paint rather than waiting for the
    // main process to push a status at subscribe time. Reading storage inside the timeout
    // keeps this out of the effect body, so the first paint is not a second render.
    const timer = window.setTimeout(() => {
      setDismissed(dismissedVersion());
      bridge.get().then(next => { if (bridge === window.sundayDesktop) setStatus(next); })
        .catch(() => setError('Sunday Room could not read its update status.'));
    },0);
    return () => { window.clearTimeout(timer); off(); };
  },[]);

  const run = useCallback((command:UpdateCommand) => {
    const bridge = api.current;
    if (!bridge) return;
    setError('');
    // Commands resolve with the resulting status, so the push channel is a progress
    // detail and the reply is the authoritative answer.
    void bridge[command]().then(setStatus).catch(() => setError('Sunday Room could not complete that request.'));
  },[]);

  const state = status?.state;
  const release = state && 'release' in state ? state.release ?? null : null;

  const dismiss = useCallback(() => {
    const version = release?.version ?? status?.currentVersion ?? '';
    setDismissed(version);
    try { localStorage.setItem(DISMISSED,version); } catch {}
  },[release,status]);

  const busy = state?.kind === 'checking' || state?.kind === 'installing';
  // Only offer a step the updater itself accepts, so the popup cannot promise one the
  // machine would refuse. A development build accepts `check` alone, so the chained action
  // falls back to asking GitHub again rather than vanishing.
  const offered = status?.commands ?? [];
  const wanted = status && state ? advanceCommand(state) : null;
  const advance = wanted && offered.includes(wanted) ? wanted : offered.includes('check') ? 'check' : null;

  // Show only when a release is actually in hand, the user has not dismissed that
  // version, and nothing is mid-flight that a popup would only interrupt.
  const showable = state !== undefined && release !== null
    && state.kind !== 'installing' && state.kind !== 'current' && state.kind !== 'unsupported';
  const show = showable && release !== null && dismissed !== release.version;

  if (!show || !status || !release || !state) return null;

  const label = advance ? commandLabel[advance] : null;
  const {text,icon:Icon} = label ?? { text: '', icon: RefreshCw };
  const downloading = state.kind === 'downloading';
  const failed = state.kind === 'failed';
  // electron-updater cannot abort a transfer, so a download in flight offers no action at
  // all. The popup stays up showing progress rather than disappearing mid-transfer.
  const advanceText = failed && advance === 'download' ? 'Retry download'
    : failed && advance === 'install' ? 'Retry install'
    : downloading ? 'Downloading'
    : text;

  return <aside className="update-popup" aria-label="Software update">
    <button className="update-popup-dismiss" type="button" onClick={dismiss} aria-label="Dismiss this update">
      <X size={15}/>
    </button>
    <div className="update-popup-heading">
      <p className="update-popup-eyebrow">{state.kind === 'checking' ? 'Checking for updates' : 'Update available'}</p>
      <h2>Sunday Room {release.version}</h2>
      <p className="update-popup-versions">Current version: {status.currentVersion}</p>
    </div>
    {state.kind === 'downloading' && <div className="update-popup-progress"><Progress value={state.percent} max={100} aria-label="Update download progress"/>
      <span>{state.percent}%</span></div>}
    {failed && state.kind === 'failed' && state.detail && <p className="update-popup-error" role="alert">{state.detail}</p>}
    <div className="update-popup-actions">
      {advance && <button className="button primary" type="button" disabled={busy || downloading} onClick={()=>run(advance)}><Icon size={14} strokeWidth={3}/>{advanceText}</button>}
      <button className="button update-popup-later" type="button" onClick={dismiss}>Dismiss</button>
    </div>
    {error && <p className="update-popup-error" role="alert">{error}</p>}
  </aside>;
}
