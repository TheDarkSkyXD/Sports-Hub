'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Download, RefreshCw, RotateCw } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { CheckFrequencySchema, describeStatus, parseUpdateFeedUrl, releasesPageUrl, updateCommands, type CheckFrequency, type DesktopUpdateBridge, type UpdateCommand, type UpdateStatus } from '@/lib/desktop-update';

const frequencyLabel:Record<CheckFrequency,string>={hourly:'Every hour',daily:'Daily',weekly:'Weekly'};

const commandLabel:Record<UpdateCommand,{text:string;icon:typeof RefreshCw;primary:boolean}> = {
  check: {text:'Check for updates',icon:RefreshCw,primary:false},
  download: {text:'Download update',icon:Download,primary:true},
  install: {text:'Install and restart',icon:RotateCw,primary:true},
};

/**
 * Settings view of the update. It reads the same bridge as the popup, so the two can never
 * disagree about what the updater is doing.
 *
 * The update source is a plain URL, which is what lets one wiring serve a packaged build
 * and a development one. It is editable in development and read-only in an installed build:
 * the feed decides which installer this app will run, and until the binary is signed there
 * is no signature on that installer to check, so a rewritable feed in a shipped app would
 * hand a code-execution primitive to anything that can write as the user.
 */
export function UpdatePanel() {
  const [status,setStatus] = useState<UpdateStatus|null>(null);
  const [absent,setAbsent] = useState(false);
  const [error,setError] = useState('');
  const [feed,setFeed] = useState('');
  const [feedError,setFeedError] = useState('');
  const [notice,setNotice] = useState('');
  const api = useRef<DesktopUpdateBridge|null>(null);
  const edited = useRef(false);

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
      bridge.get().then(next => {
        if (bridge !== window.sundayDesktop) return;
        setStatus(next);
        if (!edited.current) setFeed(next.source.url);
      }).catch(() => setError('Sunday Room could not read its update status.'));
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

  // The installed app keeps its feed, so this only takes effect in development, where the
  // field is editable. Anything that is not a GitHub releases URL is refused, because the
  // generic provider resolves `latest.yml` against whatever base it is given.
  const saveFeed = useCallback((event:React.FormEvent) => {
    event.preventDefault();
    const bridge = api.current;
    if (!bridge) return;
    const parsed = parseUpdateFeedUrl(feed);
    if (!parsed) {
      // Clear a stale success first, or a "Now checking X" would sit beside the error and
      // read as though this value had been accepted.
      setNotice('');
      setFeedError('Use a GitHub releases address, for example https://github.com/owner/name/releases/latest/download.');
      return;
    }
    setFeedError('');
    setNotice('');
    void bridge.setSource(parsed).then(next => {
      if (!next) return;
      setStatus(next);
      setFeed(next.source.url);
      setNotice(`Now checking ${next.source.url}.`);
    }).catch(() => setNotice('Sunday Room could not save that update source.'));
  },[feed]);

  // The schedule is a preference rather than a state transition, so it changes the record
  // and not the machine. A person turning it off expects it to stay off across restarts,
  // which is why it is written rather than applied for this session only.
  const savePreferences = useCallback((next:{autoCheckEnabled?:boolean;checkFrequency?:CheckFrequency}) => {
    const bridge = api.current;
    if (!bridge) return;
    setError('');
    void bridge.setPreferences(next).then(setStatus)
      .catch(() => setError('Sunday Room could not save that preference.'));
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
    <form className="update-panel-source" onSubmit={saveFeed}>
      <p className="update-panel-note">Sunday Room checks for updates at <a className="update-panel-link" href={releasesPageUrl(status.source.url)} target="_blank" rel="noopener noreferrer">{releasesPageUrl(status.source.url)} <ArrowUpRight size={12}/></a>. Downloads are checked against the checksum the published record carries; that proves the bytes came from the release, not that the release itself was legitimate.</p>
      <label htmlFor="update-source-url">Update source</label>
      <div className="update-panel-source-row">
        <input id="update-source-url" value={feed} readOnly={status.source.editable !== true}
          onChange={event => { edited.current = true; setFeed(event.target.value); setFeedError(''); }}
          placeholder="https://github.com/owner/name/releases/latest/download" spellCheck={false} autoComplete="off" disabled={busy}/>
        {status.source.editable === true && <button className="button primary" type="submit" disabled={busy}>Save source</button>}
      </div>
      {status.source.editable !== true && <p className="update-panel-note">The installed app checks this address only. The binary is not signed, so an app that could be pointed at another source would run whatever that source published.</p>}
      {status.preferences.autoCheckEnabled && <div className="update-panel-schedule">
        <label htmlFor="update-frequency">Check for updates</label>
        <select id="update-frequency" value={status.preferences.checkFrequency} disabled={busy}
          onChange={event => { const parsed = CheckFrequencySchema.safeParse(event.target.value); if (parsed.success) savePreferences({ checkFrequency: parsed.data }); }}>
          {(['hourly','daily','weekly'] as const).map(option => <option key={option} value={option}>{frequencyLabel[option]}</option>)}
        </select>
      </div>}
      <label className="update-panel-toggle">
        <input type="checkbox" checked={status.preferences.autoCheckEnabled} disabled={busy}
          onChange={event => savePreferences({ autoCheckEnabled: event.target.checked })}/>
        <span>Tell me when a new release is out</span>
      </label>
      {feedError && <p className="update-panel-error" role="alert">{feedError}</p>}
      {notice && <p className="update-panel-notice" role="status">{notice}</p>}
      {error && <p className="update-panel-error" role="alert">{error}</p>}
    </form>
  </section>;
}
