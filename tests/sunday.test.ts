import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectory, parseScoreboard, mergeGames, validFeedUrl, priority, parseSourceDate, scoreboardFeedData, scoreboardWeek } from '../lib/sunday.ts';
import type { Game } from '../lib/sunday.ts';

const team = (name: string) => ({ name, short:name, abbreviation:name.slice(0,3), color:'112233', score:'0' });
const game: Game = { id:'1', league:'nfl', name:'Away at Home', home:team('Home'), away:team('Away'), status:'in', detail:'Q1', redzone:false };

test('directory parser extracts only NFL game links without executing source scripts', () => {
 const html=`<a class="row MaclariListele" href="https://isportsurge.ws/watch/nfl/home-away/123"><span class="time-badge schedule-ss">In Progress</span><div class="team-name-event-row"><img alt="Away" src="https://cdn.example/a.png"></div><div class="team-name-event-row"><img alt="Home" src="https://cdn.example/h.png"></div></a><script>throw new Error('never execute');</script>`;
 const games=parseDirectory(html);assert.equal(games.length,1);assert.equal(games[0].sourceUrl,'https://isportsurge.ws/watch/nfl/home-away/123');assert.equal(games[0].status,'unknown');assert.equal(games[0].home.score,null);
 assert.equal(parseDirectory(html.replace('https://isportsurge.ws/watch/nfl/','https://attacker.example/')).length,0);
});
test('scoreboard handles home/away order, missing scores and red-zone state', () => {
 const data={events:[{id:'9',name:'Away at Home',status:{type:{state:'in',shortDetail:'Q2'}},competitions:[{competitors:[{id:'a',homeAway:'away',team:{displayName:'Away',name:'Away',abbreviation:'AWY',color:'ffffff'}},{id:'h',homeAway:'home',score:'7',team:{displayName:'Home',name:'Home',abbreviation:'HME',color:'000000'}}],situation:{isRedZone:true,possession:'h'}}]}]};
 const [g]=parseScoreboard(data);assert.equal(g.home.score,'7');assert.equal(g.away.score,null);assert.equal(g.redzone,true);assert.equal(g.possession,'HME');
 data.events[0].status.type.state='post';assert.equal(parseScoreboard(data)[0].redzone,false);
 assert.throws(()=>parseScoreboard({error:'blocked'}));
});

test('ESPN CDN scoreboard exposes division games and week', () => {
 const event={id:'401856704',date:'2026-09-26T16:00Z',name:'Away at Home',status:{type:{state:'pre',shortDetail:'Sat'}},competitions:[{competitors:[{homeAway:'away',team:{displayName:'Away'}},{homeAway:'home',team:{displayName:'Home'}}]}]};
 const data=scoreboardFeedData({content:{sbData:{week:{number:4},events:[event]}}},'cdn');
 const [college]=parseScoreboard(data,'ncaaf');
 assert.equal(college.id,'ncaaf-401856704');
 assert.equal(college.date,'2026-09-26T16:00Z');
 assert.equal(scoreboardWeek(data),4);
 assert.throws(()=>parseScoreboard(scoreboardFeedData({content:{}},'cdn')));
});

test('watch page date uses New York daylight rules and rejects missing or ambiguous metadata', () => {
 const html=(value:string)=>`<aside class="match-info mt-3"><dl><dt>Date:</dt><dd>${value}</dd></dl></aside>`;
 assert.equal(parseSourceDate(html('2026-09-26 12:00ET')), '2026-09-26T16:00:00.000Z');
 assert.equal(parseSourceDate(html('2026-12-26 12:00ET')), '2026-12-26T17:00:00.000Z');
 assert.equal(parseSourceDate(html('2026-03-08 02:30ET')), null);
 assert.equal(parseSourceDate(html('2026-11-01 01:30ET')), null);
 assert.equal(parseSourceDate(html('2026-02-29 12:00ET')), null);
 assert.equal(parseSourceDate(html('2026-09-26 25:00ET')), null);
 assert.equal(parseSourceDate('<script>const date="2026-09-26 12:00ET"</script>'), null);
 assert.equal(parseSourceDate(html('2026-09-26 12:00ET')+html('2026-09-26 12:00ET')), '2026-09-26T16:00:00.000Z');
 assert.equal(parseSourceDate(html('2026-09-26 12:00ET')+html('2026-09-26 13:00ET')), null);
});
test('source matching never replaces official scores or assumes team order', () => {
 const listing={...game,home:game.away,away:game.home,id:'source-1',sourceUrl:'https://isportsurge.ws/watch/nfl/a/1'};
 const [merged]=mergeGames([game],[listing]);assert.equal(merged.id,'1');assert.equal(merged.home.name,'Home');assert.equal(merged.sourceUrl,listing.sourceUrl);assert.equal(mergeGames([], [listing])[0].id,'source-1');
});
test('college directory uses exact CFB paths and keeps school names', () => {
 const html='<a class="row MaclariListele" href="https://isportsurge.ws/watch/cfb/brown-harvard/397359440"><span class="time-badge">In Progress</span><div class="team-name-event-row"><img alt="Brown Bears" src="https://cdn.example/b.png"></div><div class="team-name-event-row"><img alt="Harvard Crimson" src="https://cdn.example/h.png"></div></a>';
 const [college]=parseDirectory(html,'ncaaf');
 assert.equal(college.id,'ncaaf-source-397359440');
 assert.equal(college.away.short,'Brown Bears');
 assert.equal(college.home.short,'Harvard Crimson');
 assert.equal(parseDirectory(html,'nfl').length,0);
 assert.equal(parseDirectory(html.replace('/watch/cfb/','/watch/nfl/'),'ncaaf').length,0);
 assert.equal(parseDirectory(html.replace('isportsurge.ws','isportsurge.ws.attacker.test'),'ncaaf').length,0);
});
test('college scoreboard IDs are namespaced and source listings survive partial scores', () => {
 const data={events:[{id:'397359440',name:'Brown Bears at Harvard Crimson',status:{type:{state:'pre',shortDetail:'Sat'}},competitions:[{competitors:[{id:'b',homeAway:'away',team:{displayName:'Brown Bears',shortDisplayName:'Brown',abbreviation:'BRWN'}},{id:'h',homeAway:'home',team:{displayName:'Harvard Crimson',shortDisplayName:'Harvard',abbreviation:'HARV'}}]}]}]};
 const [scored]=parseScoreboard(data,'ncaaf');
 assert.equal(scored.id,'ncaaf-397359440');
 assert.equal(scored.away.short,'Brown');
 data.events[0].status.type.state='in';
 Object.assign(data.events[0].competitions[0],{situation:{isRedZone:true}});
 assert.equal(parseScoreboard(data,'ncaaf')[0].redzone,true);
 const listing: Game={...scored,id:'ncaaf-source-11',sourceUrl:'https://isportsurge.ws/watch/cfb/brown-harvard/11'};
 const other: Game={...scored,id:'ncaaf-source-12',home:team('Navy Midshipmen'),away:team('UAB Blazers'),sourceUrl:'https://isportsurge.ws/watch/cfb/uab-navy/12'};
 const merged=mergeGames([scored],[listing,other]);
 assert.deepEqual(merged.map(g=>g.id),['ncaaf-397359440','ncaaf-source-12']);
 assert.equal(merged[0].sourceUrl,listing.sourceUrl);
 const crossLeague={...listing,home:game.home,away:game.away};
 assert.equal(mergeGames([game],[crossLeague]).length,2);
 assert.equal(mergeGames([game],[crossLeague])[0].sourceUrl,undefined);
 assert.equal(mergeGames([scored],[listing,{...listing,id:'ncaaf-source-13',sourceUrl:'https://isportsurge.ws/watch/cfb/brown-harvard/13'}]).length,3);
 const reused={...other,sourceUrl:listing.sourceUrl};
 assert.equal(mergeGames([scored],[listing,reused])[0].sourceUrl,undefined);
});
test('feed validation rejects executable URLs and credentials but allows local video', () => {
 for(const bad of ['javascript:alert(1)','data:video/mp4;base64,abc','file:///etc/passwd','http://remote.example/video.mp4','https://user:pass@example.com/a.mp4','not a url'])assert.equal(validFeedUrl(bad),null);
 assert.equal(validFeedUrl('https://example.com/live.m3u8'),'https://example.com/live.m3u8');assert.equal(validFeedUrl('http://localhost:3001/test.mp4'),'http://localhost:3001/test.mp4');
});
test('red-zone games rank ahead of other live games and upcoming games', () => {
 assert.ok(priority({...game,redzone:true})>priority(game));assert.ok(priority(game)>priority({...game,status:'pre'}));
});
