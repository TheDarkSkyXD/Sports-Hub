const { app, BrowserWindow, session } = module.require('electron');
const { writeFileSync } = module.require('node:fs');
const Module = module.require('node:module');

const providers = [
  { name: 'sportsurge', partition: 'sportsurge-catalog' },
  { name: 'streameast', partition: 'streameast-catalog' },
];
app.setPath('userData', process.env.CATALOG_LIFETIME_PROFILE_PATH);
app.on('window-all-closed', () => {});
const phase = value => writeFileSync(`${process.env.CATALOG_LIFETIME_RESULT_PATH}.phase`, value);

function fixtureHtml(name) {
  return name === 'sportsurge'
    ? '<!doctype html><html><body><div id="match-list-container"><a class="match-row" href="#">Game</a></div></body></html>'
    : '<!doctype html><html><body><div class="m-card">Game</div></body></html>';
}

async function waitForRendererExit(pid) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    let osAlive;
    try { process.kill(pid, 0); osAlive = true; }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      osAlive = false;
    }
    if (!osAlive && !app.getAppMetrics().some(metric => metric.pid === pid)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Renderer ${pid} remained in Electron process metrics after window destruction`);
}

async function verify(provider) {
  phase(`${provider.name}: setup`);
  const catalog = module.require(`../desktop/${provider.name}-catalog.cjs`);
  const categoryUrl = catalog.CATEGORY_URLS.ncaaf;
  const expectedUrl = new URL(categoryUrl);
  const sourceSession = session.fromPartition(provider.partition);
  const requests = [];
  const pageCookies = [];
  sourceSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (url.host !== expectedUrl.host || url.pathname !== expectedUrl.pathname || url.search)
      return new Response('Not found', { status: 404 });
    requests.push({ url: request.url,
      cookies: await sourceSession.cookies.get({ url: categoryUrl }) });
    if (requests.length === 1) await sourceSession.cookies.set({
      url: categoryUrl, name: 'catalog_fixture', value: provider.name, path: '/', secure: true, sameSite: 'no_restriction',
    });
    return new Response(fixtureHtml(provider.name), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'set-cookie': `catalog_fixture=${provider.name}; Path=/; Secure; SameSite=None` },
    });
  });

  const windows = [];
  class TrackedWindow extends BrowserWindow {
    constructor(options) {
      super(options);
      const record = { window: this, partition: options.webPreferences.partition, pid: 0 };
      windows.push(record);
      this.webContents.on('did-finish-load', () => { record.pid = this.webContents.getOSProcessId(); });
    }
  }
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename?.endsWith(`${provider.name}-collector.cjs`)) {
      if (request === 'electron') return { BrowserWindow: TrackedWindow, session };
      if (request === `./${provider.name}-sweep.cjs`) {
        const name = provider.name === 'sportsurge' ? 'runSportsurgeSweep' : 'runStreameastSweep';
        return { [name]: async ({ read, signal }) => {
          await read(categoryUrl, 'category', 'ncaaf', signal);
          await read(categoryUrl, 'category', 'ncaaf', signal);
          pageCookies.push(await windows.at(-1).window.webContents.executeJavaScript('document.cookie'));
          return { state: { kind: 'complete' } };
        } };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let create;
  try {
    const exported = module.require(`../desktop/${provider.name}-collector.cjs`);
    create = provider.name === 'sportsurge' ? exported.createSportsurgeCollector : exported.createStreameastCollector;
  } finally { Module._load = originalLoad; }
  const collector = create({ origin: 'http://127.0.0.1:1', controlToken: 'fixture' });
  try {
    for (let sweep = 0; sweep < 2; sweep++) {
      phase(`${provider.name}: sweep ${sweep + 1}`);
      const result = await collector.requestSweep();
      phase(`${provider.name}: sweep ${sweep + 1} settled, ${requests.length} requests, ${windows.length} windows`);
      if (result?.state?.kind !== 'complete') throw new Error(`${provider.name} sweep ${sweep + 1} failed`);
      if (windows.length !== sweep + 1) throw new Error(`${provider.name} created ${windows.length} windows by sweep ${sweep + 1}`);
      const record = windows[sweep];
      if (!record.window.isDestroyed() || !record.pid) throw new Error(`${provider.name} window or PID was not released`);
      await waitForRendererExit(record.pid);
    }
    if (windows.some(record => record.partition !== provider.partition)) throw new Error(`${provider.name} partition changed`);
    if (windows[0].pid === windows[1].pid) throw new Error(`${provider.name} reused renderer PID`);
    if (requests.length !== 4) throw new Error(`${provider.name} expected four document requests; received ${requests.length}`);
    if (!requests[2].cookies.some(cookie => cookie.name === 'catalog_fixture' && cookie.value === provider.name))
      throw new Error(`${provider.name} cookie absent from session during second sweep request`);
    if (!pageCookies[1]?.includes(`catalog_fixture=${provider.name}`))
      throw new Error(`${provider.name} cookie missing in second renderer: ${JSON.stringify(pageCookies)}`);
    return { provider: provider.name, partition: provider.partition, rendererPids: windows.map(record => record.pid),
      requests: requests.length, cookieVisibleInSecondRenderer: true, rendererExitedAfterEachSweep: true };
  } finally { collector.stop(); sourceSession.protocol.unhandle('https'); }
}

app.whenReady().then(async () => {
  const results = [];
  let pass = false;
  try {
    for (const provider of providers) results.push(await verify(provider));
    writeFileSync(process.env.CATALOG_LIFETIME_RESULT_PATH, JSON.stringify({ pass: true, results }));
    pass = true;
  } catch (error) {
    writeFileSync(process.env.CATALOG_LIFETIME_RESULT_PATH, JSON.stringify({ pass: false, error: String(error) }));
  } finally {
    process.exit(pass ? 0 : 1);
  }
});
