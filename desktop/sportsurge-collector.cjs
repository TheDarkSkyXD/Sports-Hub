const { BrowserWindow, session } = require('electron');
const { CATEGORY_URLS, MAX_PAGE_BYTES, MAX_CHECKPOINT_BYTES, detailUrl } = require('./sportsurge-catalog.cjs');
const { runSportsurgeSweep } = require('./sportsurge-sweep.cjs');

const ORIGIN = 'https://v2.sportsurge.net';
const READY_TIMEOUT_MS = 35000;

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('unavailable')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error('unavailable')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort',onAbort); resolve(); }, ms);
    signal.addEventListener('abort',onAbort,{once:true});
  });
}
async function beforeDeadline(promise, deadline, signal, current) {
  const remaining=deadline-Date.now();
  if (remaining<=0) throw new Error('timeout');
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_,reject) => {
        timer=setTimeout(() => { current.webContents.stop(); reject(new Error('timeout')); },remaining);
        onAbort=() => { current.webContents.stop(); reject(new Error('unavailable')); };
        signal.addEventListener('abort',onAbort,{once:true});
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort',onAbort);
  }
}

function createSportsurgeCollector({ origin, controlToken }) {
  let window;
  let active;
  let timer;
  let controller;
  let stopped = false;
  let requestedPath = '';
  const sourceSession = session.fromPartition('sportsurge-catalog');
  sourceSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  sourceSession.setPermissionCheckHandler(() => false);
  sourceSession.on('will-download',event => event.preventDefault());

  function browser() {
    if (window && !window.isDestroyed()) return window;
    window = new BrowserWindow({ title: 'Sportsurge v2 collector', show: false, webPreferences: {
      partition: 'sportsurge-catalog', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
    } });
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate','will-redirect']) window.webContents.on(name, (event, target) => {
      try {
        const url = new URL(target);
        if (url.origin === ORIGIN && (url.pathname === requestedPath || url.pathname.startsWith('/cdn-cgi/challenge-platform/'))) return;
      } catch {}
      event.preventDefault();
    });
    return window;
  }

  async function document(url, page, league, signal) {
    if (page === 'category' ? url !== CATEGORY_URLS[league] : detailUrl(url, league)?.url !== url) throw new Error('invalid-detail-url');
    const current = browser();
    const deadline = Date.now() + READY_TIMEOUT_MS;
    requestedPath = new URL(url).pathname;
    await beforeDeadline(current.loadURL(url).catch(() => {}),deadline,signal,current);
    let challenge = false;
    while (Date.now() < deadline) {
      if (signal.aborted || current.isDestroyed()) throw new Error('unavailable');
      try {
        const state = await beforeDeadline(current.webContents.executeJavaScript(page === 'detail' ?
          `({url:location.href,title:document.title,ready:(()=>{const list=document.querySelector('.stream-list');return !!list&&(!!list.querySelector('.stream-item')||/no streams available|no streams found/i.test(list.textContent||''));})()})`:
          `({url:location.href,title:document.title,ready:(()=>{const box=document.querySelector('#match-list-container');if(!box)return false;if(box.querySelector('a.match-row'))return true;const empty=box.querySelector(':scope > .watch-empty-state:not(.match-filter-empty)');return !!empty&&getComputedStyle(empty).display!=='none'&&/no live or upcoming games/i.test(empty.textContent||'');})()})`,
        ),deadline,signal,current);
        challenge = /just a moment|verify you are human|checking your browser/i.test(state.title);
        if (state.url === url && state.ready && !challenge) {
          const html = await beforeDeadline(current.webContents.executeJavaScript('document.documentElement.outerHTML'),deadline,signal,current);
          if (Buffer.byteLength(html,'utf8') > MAX_PAGE_BYTES) throw new Error('limit');
          return html;
        }
      } catch (error) { if (['limit','timeout','unavailable'].includes(error?.message)) throw error; }
      await pause(500, signal);
    }
    throw new Error(challenge ? 'blocked' : 'timeout');
  }

  async function checkpoint(catalog, signal) {
    const body = JSON.stringify({ kind: 'sportsurge-catalog', catalog });
    if (Buffer.byteLength(body,'utf8') > MAX_CHECKPOINT_BYTES) throw new Error('limit');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(`${origin}/api/internal/sportsurge`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-sunday-control-token': controlToken },
          body, signal: AbortSignal.any([signal,AbortSignal.timeout(15000)]),
        });
        if (response.status === 204) return;
        await response.body?.cancel();
        if (response.status >= 400 && response.status < 500) throw new Error('parser-changed');
      } catch (error) {
        if (signal.aborted || error?.message === 'parser-changed') throw error;
      }
      if (attempt === 0) await pause(500, signal);
    }
    throw new Error('unavailable');
  }

  function requestSweep() {
    if (stopped) return;
    if (active) return active;
    controller = new AbortController();
    active = runSportsurgeSweep({
      read:(url,page,league,signal)=>document(url,page,league,signal),
      send:catalog=>checkpoint(catalog,controller.signal),signal:controller.signal,
    }).catch(() => {}).finally(() => { active = undefined; controller = undefined; });
    return active;
  }
  function start() {
    if (stopped || timer) return;
    timer = setInterval(requestSweep, 120000);
    requestSweep();
  }
  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    controller?.abort();
    if (window && !window.isDestroyed()) window.destroy();
  }
  return { start, requestSweep, stop };
}

module.exports = { createSportsurgeCollector };
