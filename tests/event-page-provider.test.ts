import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';
import { eventPageProvider } from '../lib/playback/providers/event-page.ts';
import { publishedPublicVideo } from '../lib/playback/providers/public-page.ts';
import { probeCandidate } from '../lib/playback/probe.ts';
import type { ProviderResource } from '../lib/playback/provider.ts';

const routes = [
  ['https://vipbox.fm/onair/ncaaf/montana-state-vs-idaho', 'https://vipbox.fm/live/ncaaf/montana-state-vs-idaho-2'],
  ['https://www.vipboxtv.sk/cfb/montana-state-vs-idaho-stream-live', 'https://www.vipboxtv.sk/cfb/2/stream-montana-state-vs-idaho-live'],
  ['https://strikeout.im/college-football/stream-montana-state-vs-idaho-live', 'https://strikeout.im/college-football/2/montana-state-vs-idaho-stream'],
  ['https://ppv.st/live/cfb/2026-10-03/nd-unc', 'https://embedindia.st/embed/cfb/2026-10-03/nd-unc/skycast'],
] as const;

test('event page policy binds published server routes to their exact event', () => {
  for (const [event, server] of routes) assert.equal(validEventPagePair(event, server), true);
  for (const [event, server] of routes.slice(0,3)) {
    assert.equal(validEventPagePair(event, server.replace('2', '5')), true);
    assert.equal(validEventPagePair(event, server.replace('2', '9')), true);
  }
  const [event, server] = routes[0];
  for (const invalid of [
    server.replace('montana-state-vs-idaho', 'other-game'),
    server.replace('vipbox.fm', 'evil.example'),
    server.replace('https:', 'http:'),
    server.replace('vipbox.fm', 'vipbox.fm:8443'),
    `${server}?token=secret`, `${server}#player`,
    server.replace('vipbox.fm', 'user@vipbox.fm'),
    server.replace('-2', '-0'), server.replace('-2', '-10000'),
  ]) assert.equal(validEventPagePair(event, invalid), false, invalid);
  assert.equal(validEventPagePair(routes[1][0], routes[2][1]), false);
  assert.equal(validEventPagePair(routes[3][0], routes[3][1].replace('nd-unc', 'other-game')), false);
});

test('event page provider rejects an unrelated server before invoking the browser observer', async () => {
  let opened = false;
  const provider = eventPageProvider(async () => { opened = true; throw new Error('unexpected observer call'); });
  await assert.rejects(provider.open({ provider:'event-page', gameId:'ncaaf-401868094',
    eventUrl:routes[0][0], serverUrl:routes[0][1].replace('idaho', 'other') },
    new AbortController().signal, 'probe'), /Unsupported event page/);
  assert.equal(opened, false);
});

test('NFLStreams free player opens within its published event page', async () => {
  const event='https://nflstreams.org/teams/carolina-panthers-live/';
  const server='https://piratecat.store/sports/player.php?hd=fixture-server-01=live';
  const calls:{destination:string;embeddedEvent:string|null}[]=[];
  const provider=eventPageProvider(async(destination,_signal,_purpose,embeddedEvent)=>{
    calls.push({destination:destination.href,embeddedEvent:embeddedEvent?.href||null});
    return null;
  });
  const locator={provider:'event-page' as const,gameId:'401872978',eventUrl:event,serverUrl:server};
  await assert.rejects(provider.open(locator,new AbortController().signal,'probe'),/did not publish supported media/);
  assert.deepEqual(calls,[{destination:server,embeddedEvent:event}]);
  await assert.rejects(provider.open({...locator,serverUrl:'https://piratecat.store/premium.php'},
    new AbortController().signal,'probe'),/Unsupported event page/);
  assert.equal(calls.length,1);
});

test('Buffstream player opens within its published team page', async () => {
  const event='https://ms.buffstream.io/nfl-streams/carolina-panthers-live-stream';
  const server='https://embedsports.me/american-football/carolina-panthers-vs-detroit-lions-stream-1';
  const calls:{destination:string;embeddedEvent:string|null}[]=[];
  const provider=eventPageProvider(async(destination,_signal,_purpose,embeddedEvent)=>{
    calls.push({destination:destination.href,embeddedEvent:embeddedEvent?.href||null});
    return null;
  });
  const locator={provider:'event-page' as const,gameId:'401872978',eventUrl:event,serverUrl:server};
  await assert.rejects(provider.open(locator,new AbortController().signal,'probe'),/did not publish supported media/);
  assert.deepEqual(calls,[{destination:server,embeddedEvent:event}]);
  await assert.rejects(provider.open({...locator,serverUrl:server.replace('carolina-panthers','chicago-bears')},
    new AbortController().signal,'probe'),/Unsupported event page/);
  assert.equal(calls.length,1);
});

test('a PPV server receives its parent referer and only one player video is statically accepted', async () => {
  const parent=new URL(routes[3][0]),server=new URL(routes[3][1]);
  const requests:{url:string;referer:string|null}[]=[];
  const requester=async(url:URL,_signal:AbortSignal,headers:Headers):Promise<Response>=>{
    requests.push({url:url.href,referer:headers.get('referer')});
    return url.href===server.href
      ? new Response('<script>const hlsUrl="https://ads.example/ad.m3u8"</script><main><div id="player"><video><source src="https://media.example/game.m3u8"></video></div></main>',
        {headers:{'content-type':'text/html'}})
      : new Response('#EXTM3U\n#EXT-X-VERSION:3\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}});
  };
  const playback=await publishedPublicVideo(server,parent,new AbortController().signal,requester);
  assert.equal(playback?.root.identity,'https://media.example/game.m3u8');
  const read=await playback?.root.read({signal:new AbortController().signal});
  await read?.body?.cancel();
  assert.deepEqual(requests,[
    {url:server.href,referer:parent.href},
    {url:'https://media.example/game.m3u8',referer:server.href},
  ]);
  const scriptOnly=await publishedPublicVideo(server,parent,new AbortController().signal,async()=>
    new Response('<script>const hlsUrl="https://ads.example/ad.m3u8"</script>',{headers:{'content-type':'text/html'}}));
  assert.equal(scriptOnly,null);
});

test('every admitted route remains unplayable until its media segment passes the probe', async () => {
  const media=Buffer.alloc(188*4);
  for(let offset=0;offset<media.length;offset+=188)media[offset]=0x47;
  const locator=(eventUrl:string,serverUrl:string)=>({provider:'event-page' as const,
    gameId:'ncaaf-401868094',eventUrl,serverUrl});
  for(const [eventUrl,serverUrl] of routes) for(const valid of [true,false]) {
    const resource=(kind:'playlist'|'media'):ProviderResource=>({
      kind,identity:`${serverUrl}/${kind}`,
      resolve(_reference,expected){return resource(expected);},
      async read(){return {status:200 as const,contentType:kind==='playlist'?'application/vnd.apple.mpegurl':'video/mp2t',
        body:new Response(kind==='playlist'?'#EXTM3U\n#EXTINF:4,\nsegment.ts\n':valid?media:'<html>ad</html>').body};},
    });
    let closed=false;
    const provider=eventPageProvider(async()=>({root:resource('playlist'),close(){closed=true;}}));
    const result=await probeCandidate(locator(eventUrl,serverUrl),new AbortController().signal,
      (value,signal,purpose)=>{
        if(value.provider!=='event-page')throw new Error('unexpected locator');
        return provider.open(value,signal,purpose);
      });
    assert.equal(result.kind,valid?'playable':'unavailable');
    assert.equal(closed,true);
  }
});
