import { app } from 'electron';
import observerModule from '../../desktop/sportsurge-observer.cjs';

const { createSportsurgeObserver } = observerModule;

if (!process.connected || !process.env.SUNDAY_ROOM_CONTROL_TOKEN ||
  !process.env.SUNDAY_ROOM_FIXTURE_PROFILE) process.exit(1);

app.commandLine.appendSwitch('ignore-certificate-errors');
app.setPath('userData', process.env.SUNDAY_ROOM_FIXTURE_PROFILE);
app.on('window-all-closed', () => {});

const resolveAddress = async (host, isActive) => {
  if (!isActive() || !['fixture.example', 'other.fixture.example'].includes(host))
    throw new Error('Fixture host is not allowed');
  return { address: '127.0.0.1', family: 4 };
};

let observer;
const stop = () => {
  observer?.stop();
  app.quit();
};
process.on('disconnect', stop);
process.on('message', message => { if (message?.kind === 'stop') stop(); });
app.whenReady().then(async () => {
  observer = createSportsurgeObserver({
    controlToken: process.env.SUNDAY_ROOM_CONTROL_TOKEN,
    resolveAddress,
  });
  process.send({ kind: 'ready', origin: await observer.start() });
}).catch(error => {
  console.error(error);
  stop();
});
