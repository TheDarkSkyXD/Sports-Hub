import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectory, parseScoreboard, mergeGames, validFeedUrl, priority } from '../lib/sunday.ts';
import type { Game } from '../lib/sunday.ts';

const team = (name: string) => ({ name, short:name, abbreviation:name.slice(0,3), color:'112233', score:'0' });
const game: Game = { id:'1', name:'Away at Home', home:team('Home'), away:team('Away'), status:'in', detail:'Q1', redzone:false };

test('directory parser extracts only NFL game links without executing source scripts', () => {
 const html=`<a class="row MaclariListele" href="https://isportsurge.ws/watch/nfl/home-away/123"><span class="time-badge schedule-ss">In Progress</span><div class="team-name-event-row"><img alt="Away" src="https://cdn.example/a.png"></div><div class="team-name-event-row"><img alt="Home" src="https://cdn.example/h.png"></div></a><script>throw new Error('never execute');</script>`;
 const games=parseDirectory(html);assert.equal(games.length,1);assert.equal(games[0].sourceUrl,'https://isportsurge.ws/watch/nfl/home-away/123');assert.equal(games[0].status,'unknown');assert.equal(games[0].home.score,null);
 assert.equal(parseDirectory(html.replace('https://isportsurge.ws/watch/nfl/','https://attacker.example/')).length,0);
});

test('directory links survive reordered attributes and repeated source listings', () => {
 const html=`<a href='https://isportsurge.ws/watch/nfl/home-away/123' class='row MaclariListele'><span title='Live' class='schedule-ss time-badge'>In Progress</span><div class='team-name-event-row'><span><img src='https://cdn.example/a.png' alt='Away'></span></div><div class='team-name-event-row'><img src='https://cdn.example/h.png' alt='Home'></div></a>`;
 const games=parseDirectory(html+html.replace('home-away/123','renamed-game/123'));
 assert.equal(games.length,1);assert.equal(games[0].id,'source-123');assert.equal(games[0].home.name,'Home');assert.equal(games[0].detail,'Listed live · score unavailable');
 assert.equal(parseDirectory(html.replace('home-away/123','home-away/123?redirect=unsafe')).length,0);
});
test('scoreboard handles home/away order, missing scores and red-zone state', () => {
 const data={events:[{id:'9',name:'Away at Home',status:{type:{state:'in',shortDetail:'Q2'}},competitions:[{competitors:[{id:'a',homeAway:'away',team:{displayName:'Away',name:'Away',abbreviation:'AWY',color:'ffffff'}},{id:'h',homeAway:'home',score:'7',team:{displayName:'Home',name:'Home',abbreviation:'HME',color:'000000'}}],situation:{isRedZone:true,possession:'h'}}]}]};
 const [g]=parseScoreboard(data);assert.equal(g.home.score,'7');assert.equal(g.away.score,null);assert.equal(g.redzone,true);assert.equal(g.possession,'HME');
 data.events[0].status.type.state='post';assert.equal(parseScoreboard(data)[0].redzone,false);
 assert.throws(()=>parseScoreboard({error:'blocked'}));
});

test('one malformed scoreboard entry cannot discard valid games', () => {
 const valid={id:'9',competitions:[{competitors:[null,{homeAway:'away',team:{displayName:'Away'},records:'not an array',score:{}},{homeAway:'home',team:{displayName:'Home'},records:[null],score:7}],broadcasts:[{names:42}],situation:{possession:null},status:{type:{state:'in',shortDetail:'Q2'}}}]};
 const games=parseScoreboard({events:[null,42,[],{}, {id:'missing',competitions:[null]},valid,valid]});
 assert.equal(games.length,1);assert.equal(games[0].name,'Away at Home');assert.equal(games[0].home.score,'7');assert.equal(games[0].away.score,null);assert.equal(games[0].home.abbreviation,'H');assert.equal(games[0].broadcast,undefined);assert.equal(games[0].status,'in');assert.equal(games[0].possession,undefined);
 assert.throws(()=>parseScoreboard({events:[null,{invalid:true}]}),/no valid games/);assert.deepEqual(parseScoreboard({events:[]}),[]);
});

test('scoreboard strips invalid optional values and normalizes numeric possession IDs', () => {
 const data={events:[{id:9,name:{invalid:true},date:'not a date',status:{type:{state:'in',shortDetail:99}},competitions:[{competitors:[{id:1,homeAway:'away',team:{displayName:'Away',abbreviation:'AWY'}},{id:2,homeAway:'home',team:{displayName:'Home',abbreviation:'HME'},score:'21',records:[{type:'total',summary:{invalid:true}}]}],situation:{isRedZone:true,possession:'2',lastPlay:{text:7}},broadcasts:[{names:['CBS',null,42,'']}],venue:{fullName:3}}]}]};
 const [g]=parseScoreboard(data);assert.equal(g.date,undefined);assert.equal(g.name,'Away at Home');assert.equal(g.detail,'Status unavailable');assert.equal(g.possession,'HME');assert.equal(g.home.record,undefined);assert.equal(g.lastPlay,undefined);assert.equal(g.broadcast,'CBS');assert.equal(g.venue,undefined);
});
test('source matching never replaces official scores or assumes team order', () => {
 const listing={...game,home:game.away,away:game.home,id:'source-1',sourceUrl:'https://isportsurge.ws/watch/nfl/a/1'};
 const [merged]=mergeGames([game],[listing]);assert.equal(merged.id,'1');assert.equal(merged.home.name,'Home');assert.equal(merged.sourceUrl,listing.sourceUrl);assert.equal(mergeGames([], [listing])[0].id,'source-1');
});
test('feed validation rejects executable URLs and credentials but allows local video', () => {
 for(const bad of ['javascript:alert(1)','data:video/mp4;base64,abc','file:///etc/passwd','http://remote.example/video.mp4','https://user:pass@example.com/a.mp4','not a url'])assert.equal(validFeedUrl(bad),null);
 assert.equal(validFeedUrl('https://example.com/live.m3u8'),'https://example.com/live.m3u8');assert.equal(validFeedUrl('http://localhost:3001/test.mp4'),'http://localhost:3001/test.mp4');
});
test('red-zone games rank ahead of other live games and upcoming games', () => {
 assert.ok(priority({...game,redzone:true})>priority(game));assert.ok(priority(game)>priority({...game,status:'pre'}));
});

test('unknown or invalid scores do not receive a close-game priority bonus', () => {
 const unknown={...game,home:{...game.home,score:null},away:{...game.away,score:null}};
 assert.equal(priority(unknown),100);assert.equal(priority({...unknown,home:{...game.home,score:''}}),100);assert.equal(priority({...unknown,home:{...game.home,score:'unknown'}}),100);assert.equal(priority(game),115);
});
