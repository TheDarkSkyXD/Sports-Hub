const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const directory = path.resolve('work/sportsurge-catalog-electron');
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', path.join(directory, `profile-${Date.now()}`));
const result = { at: new Date().toISOString(), mode: 'Normal Electron launch without remote debugging flags; actual app and production routes', evidence: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let monitoring = false;
const flush = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ ...result,
  evidence: result.evidence.map(page => ({ ...page, providers: page.providers.map(row => ({ label: row.label,
    urlDigest: createHash('sha256').update(row.url || '').digest('hex') })) })),
}, null, 2));

app.on('browser-window-created', (_event, window) => {
  const contents = window.webContents;
  contents.on('did-finish-load', () => {
    const url = contents.getURL();
    if (url.startsWith('https://v2.sportsurge.net/')) {
      void contents.executeJavaScript(`({url:location.href,title:document.title,at:Date.now(),
        games:[...document.querySelectorAll('a.match-row')].map(row=>({url:row.href,teams:[...row.querySelectorAll('.match-row-team-name')].map(team=>team.textContent.trim())})),
        providers:[...document.querySelectorAll('.stream-item')].map(row=>({label:row.querySelector('.stream-row-site-name')?.textContent.trim(),url:row.getAttribute('data-href')})),
        empty:!!document.querySelector('#match-list-container > .watch-empty-state:not(.match-filter-empty)')})`)
        .then(snapshot => { if(snapshot.title!=='Just a moment...') result.evidence.push(snapshot); })
        .catch(() => {});
    }
    if (!monitoring && /^http:\/\/127\.0\.0\.1:/.test(url)) {
      monitoring = true;
      void verify(window, new URL(url).origin);
    }
  });
});

async function click(window, expression) {
  const point = await window.webContents.executeJavaScript(`(()=>{const element=${expression};if(!element)throw new Error('Missing element');element.scrollIntoView({block:'center'});const box=element.getBoundingClientRect();return {x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)};})()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
}

async function verify(window, origin) {
  result.origin = origin;
  try {
    await pause(1000);
    await click(window, `document.querySelector('button[aria-label="Room settings"]')`);
    for(let attempt=0;attempt<120;attempt++) {
      const response=await fetch(`${origin}/api/sources`,{signal:AbortSignal.timeout(60000)});
      if(response.ok) {
        result.snapshot=await response.json();
        const scan=result.snapshot.sportsurgeV2.current;
        console.log(JSON.stringify({stage:'inventory',attempt,state:scan?.state,games:scan?.gameCount,collected:scan?.collectedDetails,failed:scan?.failedDetails,providers:scan?.providerRows}));
        flush();
        if(scan?.state.kind==='complete'||scan?.state.kind==='partial')break;
      }
      await pause(5000);
    }
    const scan=result.snapshot.sportsurgeV2.current;
    assert.equal(scan?.state.kind,'complete','Both catalogs and every discovered detail complete in the actual app');
    const cfb=result.evidence.find(item=>item.url.endsWith('/watch-cfb-streams/'));
    const nfl=result.evidence.find(item=>item.url.endsWith('/watch-nfl-streams/'));
    assert(cfb&&nfl,'The observer saw both category pages');
    assert(nfl.games.length||nfl.empty,'NFL is populated or explicitly empty');
    const urls=[...new Set([...cfb.games,...nfl.games].map(item=>item.url))].sort();
    assert.deepEqual(scan.games.map(game=>game.url).sort(),urls);
    let providerRows=0;
    for(const game of scan.games) {
      const detail=result.evidence.find(item=>item.url===game.url);
      assert(detail,`Observed ${game.url}`);
      assert.equal(game.detail.kind,'collected');
      assert.equal(game.detail.providers.length,detail.providers.length);
      assert.deepEqual(game.detail.providers.map(row=>row.label).sort(),detail.providers.map(row=>row.label).sort());
      const actual=game.detail.providers.filter(row=>row.destination.kind==='link').map(row=>row.destination.url).sort();
      const expected=detail.providers.flatMap(row=>{try{return row.url?[new URL(row.url,game.url).href]:[];}catch{return[];}}).sort();
      if(actual.length===expected.length)assert.deepEqual(actual,expected);
      else for(const url of actual)assert(expected.includes(url));
      providerRows+=detail.providers.length;
    }
    assert.equal(scan.providerRows,providerRows);
    assert.equal(scan.pendingDetails,0);
    assert.equal(scan.failedDetails,0);
    result.verified={games:urls.length,providerRows,rejectedProviders:scan.rejectedProviders,cfb:cfb.games.length,nfl:nfl.games.length,runId:scan.runId};
    await pause(3500);
    const sourceExpression=`[...document.querySelectorAll('details.source-inventory-item')].find(row=>row.querySelector(':scope > summary > strong')?.textContent==='Sportsurge v2')`;
    await click(window,`${sourceExpression}?.querySelector(':scope > summary')`);
    await pause(500);
    const sourceText=await window.webContents.executeJavaScript(`${sourceExpression}?.innerText`);
    assert(sourceText.includes(`${scan.providerRows} provider rows`),'Settings updated automatically to the complete provider count');
    assert(sourceText.includes(`${scan.gameCount} games`));
    fs.writeFileSync(path.join(directory,'settings-summary.png'),(await window.webContents.capturePage()).toPNG());
    if(scan.games.length) {
      await click(window,`${sourceExpression}?.querySelector('.source-inventory-catalog details > summary')`);
      await pause(500);
      fs.writeFileSync(path.join(directory,'settings-providers.png'),(await window.webContents.capturePage()).toPNG());
      const providerLinks=await window.webContents.executeJavaScript(`Array.from((${sourceExpression}).querySelectorAll('.source-inventory-catalog details[open] a'),link=>link.href)`);
      const first=scan.games[0];
      assert(providerLinks.includes(first.url));
      for(const row of first.detail.providers)if(row.destination.kind==='link')assert(providerLinks.includes(row.destination.url));
    }
    result.settings={automaticCounts:true,providerLinks:scan.games.length>0};
    result.pass=true;
    console.log(JSON.stringify({stage:'verified',...result.verified}));
  } catch(error) {
    result.error=String(error.stack||error);
    process.exitCode=1;
    console.log(JSON.stringify({stage:'failure',error:result.error}));
    try{fs.writeFileSync(path.join(directory,'failure.png'),(await window.webContents.capturePage()).toPNG());}catch{}
  } finally {
    flush();
    app.quit();
  }
}

require(path.resolve(__dirname,'../desktop/main.cjs'));
