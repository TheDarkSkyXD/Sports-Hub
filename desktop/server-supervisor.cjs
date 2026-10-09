const { spawn } = require('node:child_process');

const [nextCli, mode, port] = process.argv.slice(2);
const command = mode === 'build' || mode === 'prepare';
if (!process.connected || !nextCli || !['start', 'dev', 'standalone', 'build', 'prepare'].includes(mode) ||
    !(command ? /^\.desktop-runtime\/local-builds\/[a-f0-9-]+$/.test(port || '') : /^\d{1,5}$/.test(port || ''))) process.exit(1);

const args = mode === 'standalone' ? [nextCli] : mode === 'build'
  ? [nextCli, 'build', ...(process.env.SUNDAY_ROOM_BUILD_WEBPACK === '1' ? ['--webpack'] : [])]
  : mode === 'prepare' ? [nextCli, port] : [nextCli, mode, '--hostname', '127.0.0.1', '--port', port];
const next = spawn(process.execPath,args,{
  cwd:process.cwd(),env:{...process.env,...(command ? {} : {PORT:port,HOSTNAME:'127.0.0.1'})},windowsHide:true,stdio:['ignore','inherit','inherit'],
});
let stopRequested = false;
let killPending = false;
let nextExited = false;
let treeCommandSucceeded = false;

function terminateTree() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let commandDone = false;
    let targetExited = nextExited || next.exitCode !== null || next.signalCode != null;
    let killer;
    const onTargetExit = () => { targetExited = true; complete(); };
    const onKillerError = error => finish(new Error(`Next tree kill failed: ${error}`));
    const onKillerExit = code => {
      if (code !== 0) finish(new Error(`Next tree kill exited with code ${code}`));
      else { treeCommandSucceeded = true; commandDone = true; complete(); }
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      next.off('exit', onTargetExit);
      killer?.off('exit', onKillerExit);
      if (error) reject(error);
      else resolve();
    };
    const complete = () => { if (commandDone && targetExited) finish(); };
    const timer = setTimeout(() => {
      try { killer?.kill?.(); } catch {}
      finish(new Error('Next tree kill timed out before process exit'));
    }, 5000);
    next.once('exit', onTargetExit);
    if (process.platform === 'win32') {
      try {
        killer = spawn('taskkill.exe', ['/PID', String(next.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', onKillerError);
        killer.once('exit', onKillerExit);
      } catch (error) { finish(new Error(`Next tree kill failed: ${error}`)); }
    } else {
      try {
        if (!next.kill()) finish(new Error('Next process kill failed'));
        else { commandDone = true; complete(); }
      } catch (error) { finish(new Error(`Next process kill failed: ${error}`)); }
    }
  });
}

function stop() {
  stopRequested = true;
  if (killPending) return;
  if (!next.pid || nextExited) {
    if (nextExited) process.exit(treeCommandSucceeded ? 0 : 1);
    return;
  }
  killPending = true;
  void terminateTree().then(
    () => { process.exit(0); },
    () => {
      killPending = false;
      process.exitCode = 1;
      if (nextExited) process.exit(treeCommandSucceeded ? 0 : 1);
    },
  );
}

process.on('disconnect',stop);
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
next.on('error',() => process.exit(1));
next.on('exit',code => {
  nextExited = true;
  if (command && !stopRequested) { process.send({ kind: 'complete', code }); return; }
  if (!stopRequested) process.exit(code || 1);
  else if (!killPending) process.exit(treeCommandSucceeded ? 0 : 1);
});
