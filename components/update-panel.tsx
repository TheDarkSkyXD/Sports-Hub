'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Download, RefreshCw, RotateCw } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { describeStatus, releaseFeedUrl, updateCommands, type DesktopUpdateBridge, type UpdateCommand, type UpdateStatus } from '@/lib/desktop-update';

const commandLabel:Record<UpdateCommand,{text:string;icon:typeof RefreshCw;primary:boolean}> = {
  check: {text:'Check for updates',icon:RefreshCw,primary:false},
  download: {text:'Download update',icon:Download,primary:true},
  install: {text:'Install and restart',icon:RotateCw,primary:true},
};

/**
 * Settings view of the update. It reads the same bridge as the popup, so the two can never
 * disagree about what the updater is doing.
 *
 * There is no source field to edit. The feed is baked into the build by electron-builder,
 * and the binary is unsigned, so an app that could be pointed at another repository would
 * run whatever that repository published. The address is shown instead, so it is visible
 * and checkable without being a lever.
 */
export function UpdatePanel() {
  const [status,setStatus] = useState<UpdateStatus|null>(null);
  const [absent,setAbsent] = useState(false);
  const [error,setError] = useState('');
  const api = useRef<DesktopUpdateBridge|null>(null);

  useEffect(()=>{
    // Read directly rather than from a prop: `app/page.tsx` sets its `desktop` flag in a
    // `window.setTimeout(..., 0)` effect, so a prop would flash "browser" for one frame.
    const bridge = typeof window === 'undefined' ? undefined : window.sundayDesktop;
    if (!bridge) {
      // Nothing to subscribe to, and no need to ask. Deciding inside a timeout keeps this
      // out of the effect body, so the first paint is not a second render.
      const timer = window.setTimeout(() => setAbsent(true), 0);
      return () => window.clearTimeout(timer);
    }
    api.current = bridge;
    const off = bridge.subscribe(next => { if (bridge === window.sundayDesktop) setStatus(next); });
    // `get` exists so the panel has content on the first paint rather than waiting for the
    // main process to push a status at subscribe time.
    const timer = window.setTimeout(() => {
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
    void bridge[command]().then(setStatus)
      .catch(() => setError('Sunday Room could not complete that request.'));
  },[]);

  if (absent) return null;
  if (!status) return <section className="update-panel" aria-label="Software update"><h3>Software update</h3>
    <p className="update-panel-note">Reading the update status…</p></section>;

  const state = status.state;
  const release = 'release' in state ? state.release : null;
  const busy = state.kind === 'checking' || state.kind === 'installing' || state.kind === 'downloading';
  const upToDate = state.kind === 'current';
  const download = state.kind === 'downloading'
    ? <div className="update-panel-progress"><Progress value={state.percent} max={100} aria-label="Update download progress"/>
      <span>{state.percent}%</span></div>
    : null;

  return <section className="update-panel" aria-label="Software update">
    <div className="update-panel-heading"><div><h3>Software update</h3>
      <p className="update-panel-state" role="status">{describeStatus(status)}</p></div>
      <div className="update-panel-actions">{updateCommands.filter(command => status.commands.includes(command)).map(command => {
        const {text,icon:Icon,primary} = commandLabel[command];
        return <button key={command} className={primary?'button primary':'button subtle'} type="button" disabled={busy} onClick={()=>run(command)}><Icon size={14}/>{text}</button>;
      })}</div></div>
    {upToDate&&<p className="update-panel-current" role="status"><Check size={14}/>You are on the latest version. Nothing to install.</p>}
    <p className="update-panel-versions">Installed {status.currentVersion} · Latest {release ? release.version : status.currentVersion}</p>
    {download}
    {release && <p><a className="update-panel-link" href={release.pageUrl} target="_blank" rel="noopener noreferrer">What changed in {release.version} <ArrowUpRight size={13}/></a></p>}
    <div className="update-panel-source">
      <p className="update-panel-note">Sunday Room checks for updates at <a className="update-panel-link" href={releaseFeedUrl(status.source.repo)} target="_blank" rel="noopener noreferrer">{releaseFeedUrl(status.source.repo)} <ArrowUpRight size={12}/></a>, using the updater built into this install. Downloads are checked against the checksum the published record carries; that proves the bytes came from the release, not that the release itself was legitimate.</p>
      {error && <p className="update-panel-error" role="alert">{error}</p>}
    </div>
  </section>;
}
