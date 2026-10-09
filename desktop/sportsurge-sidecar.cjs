const { app } = require('electron');
const { createSportsurgeCollector } = require('./sportsurge-collector.cjs');
const { createSportsurgeObserver } = require('./sportsurge-observer.cjs');
const { createStreameastCollector } = require('./streameast-collector.cjs');

const origin = process.env.SUNDAY_ROOM_COLLECTOR_ORIGIN;
const controlToken = process.env.SUNDAY_ROOM_CONTROL_TOKEN;
if (!origin || !controlToken || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin) ||
  !process.connected) process.exit(1);

app.setName('Sunday Room Sportsurge Collector');
let collector;
let streameastCollector;
let observer;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  collector?.stop();
  streameastCollector?.stop();
  observer?.stop();
  app.quit();
}

process.on('disconnect', stop);
process.on('message', message => {
  if (message?.kind === 'stop') stop();
  if (message?.kind === 'start' && !stopping && !collector) {
    collector = createSportsurgeCollector({ origin, controlToken });
    collector.start();
    streameastCollector = createStreameastCollector({ origin, controlToken });
    streameastCollector.start();
  }
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  if (stopping) return;
  let observerOrigin = null;
  try {
    observer = createSportsurgeObserver({ controlToken });
    observerOrigin = await observer.start();
    observer.configureVerifier(origin);
  } catch (error) {
    observer?.stop();
    observer = undefined;
    console.error('Sportsurge observer unavailable:', error);
  }
  process.send({ kind: 'ready', origin: observerOrigin });
}).catch(error => {
  console.error('Sportsurge collector could not start:', error);
  stop();
});
