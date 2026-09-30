'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Download, RefreshCw, RotateCw } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { describeStatus, parseReleaseSource, releasePageUrl, updateCommands, type DesktopUpdateBridge, type UpdateCommand, type UpdateStatus } from '@/lib/desktop-update';

const commandLabel:Record<UpdateCommand,{text:string;icon:typeof RefreshCw;primary:boolean}> = {
  check: {text:'Check for updates',icon:RefreshCw,primary:false},
  download: {text:'Download update',icon:Download,primary:true},
  cancel: {text:'Cancel',icon:RotateCw,primary:false},
  install: {text:'Install and restart',icon:Download,primary:true},
};

const originLabel = { packaged:'the default release source', file:'a custom release source', environment:'a development override' } as const;
const megabytes = (bytes:number) => `${(bytes / 1048576).toFixed(1)} MB`;

export function UpdatePanel() {
  const [status,setStatus] = useState<UpdateStatus|null>(null);
  const [absent,setAbsent] = useState(false);
  const [repo,setRepo] = useState('');
  const [repoError,setRepoError] = useState('');
  const [notice,setNotice] = useState('');
  const api = useRef<DesktopUpdateBridge|null>(null);
  const edited = useRef(false);

  useEffect(()=>{
    // Read directly rather than from a prop: `app/page.tsx` sets its `desktop` flag in a
    // `window.setTimeout(..., 0)` effect, so a prop would flash "browser" for one frame.
    const bridge = typeof window === 'undefined' ? undefined : window.sundayDesktop;
    api.current = bridge ?? null;
    let live = true;
    const off = bridge ? bridge.subscribe(next => { if (live) setStatus(next); }) : () => {};
    const timer = window.setTimeout(() => {
      if (!bridge) { if (live) setAbsent(true); return; }
      // `get` exists so the panel has a state on the first paint instead of waiting for
      // the main process to push one at subscribe time.
      bridge.get().then(next => {
        if (!live) return;
        setStatus(next);
        if (!edited.current) setRepo(releasePageUrl(next.source.repo));
      }).catch(() => { if (live) setNotice('Sunday Room could not read its update status.'); });
    },0);
    return () => { live=false; window.clearTimeout(timer); off(); };
  },[]);

  const run = useCallback((command:UpdateCommand) => {
    const bridge = api.current;
    if (!bridge) return;
    setNotice('');
    // Commands resolve with the resulting status, so the push channel is a progress
    // detail and the reply is the authoritative answer.
    void bridge[command]().then(setStatus).catch(() => setNotice('Sunday Room could not complete that request.'));
  },[]);

  const saveSource = useCallback((event:React.FormEvent) => {
    event.preventDefault();
    const bridge = api.current;
    if (!bridge) return;
      const parsed = parseReleaseSource(repo);
      if (!parsed) {
        // Clear the last success notice first, or a stale "Now checking X" would sit
        // beside the error and read as if this value had been accepted.
        setNotice('');
        setRepoError('That is not a GitHub releases address. Use https://github.com/owner/name/releases.');
        return;
      }
      setRepoError('');
      setNotice('');
      void bridge.setSource(parsed).then(next => {
        setStatus(next);
        setRepo(releasePageUrl(next.source.repo));
        setNotice(`Now checking ${next.source.repo}.`);
      }).catch(() => setNotice('Sunday Room could not save that update source.'));
  },[repo]);

  if (absent) return <section className="update-panel" aria-label="Software update"><p className="update-panel-state" role="status">Automatic updates run in the installed Windows app.</p></section>;
  if (!status) return <section className="update-panel" aria-label="Software update"><p className="update-panel-state">Reading the update status…</p></section>;

  const state = status.state;
  const release = 'release' in state ? state.release : null;
  const busy = state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'installing';
  const upToDate = state.kind === 'current';
  const download = state.kind === 'downloading'
    ? <div className="update-panel-progress"><Progress value={Math.round((state.received / state.total) * 100)} max={100} aria-label="Update download progress"/>
      <span>{megabytes(state.received)} of {megabytes(state.total)}</span></div>
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
    <form className="update-panel-source" onSubmit={saveSource}>
        <label htmlFor="update-source-repo">Update source</label>
        <div className="update-panel-source-row">
          {/* The field holds the releases URL, because that is the address a person can
              find and paste. The app stores the `owner/name` it names and derives the feed. */}
          <input id="update-source-repo" value={repo} onChange={event => { edited.current = true; setRepo(event.target.value); setRepoError(''); }}
            placeholder="https://github.com/owner/name/releases" spellCheck={false} autoComplete="off" disabled={busy}/>
          <button className="button primary" type="submit" disabled={busy}>Save source</button>
        </div>
      {repoError && <p className="update-panel-error" role="alert">{repoError}</p>}
      {notice && <p className="update-panel-notice" role="status">{notice}</p>}
      <p className="update-panel-note">Sunday Room looks for releases on GitHub. This build reads {originLabel[status.source.origin]}, <strong>{status.source.repo}</strong>. Downloads are checked against the size and sha256 the release publishes; that proves the bytes came from GitHub, not that the release itself was legitimate.</p>
    </form>
  </section>;
}
