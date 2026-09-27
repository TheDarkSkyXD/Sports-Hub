const { spawn } = require('node:child_process');

const [nextCli, mode, port] = process.argv.slice(2);
if (!process.connected || !nextCli || !['start', 'dev', 'standalone'].includes(mode) || !/^\d{1,5}$/.test(port || '')) process.exit(1);

const next = spawn(process.execPath,mode === 'standalone' ? [nextCli] : [nextCli,mode,'--hostname','127.0.0.1','--port',port],{
  cwd:process.cwd(),env:{...process.env,PORT:port,HOSTNAME:'127.0.0.1'},windowsHide:true,stdio:['ignore','inherit','inherit'],
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!next.pid || next.exitCode !== null) { process.exit(0); return; }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe',['/PID',String(next.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.on('error',() => next.kill());
    killer.on('exit',code => { if (code !== 0) next.kill(); });
  } else next.kill();
}
process.on('disconnect',stop);
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
next.on('error',() => process.exit(1));
next.on('exit',code => process.exit(stopping ? 0 : code || 1));
