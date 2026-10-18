import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';

const fixture=JSON.parse(await readFile(new URL('./fixtures/espn-college-divisions-20261017.json',import.meta.url),'utf8'));
const expected=fixture.scoreboards['35'].future.events[0];
const gameId=`ncaaf-${expected.id}`;
const targets=await(await fetch('http://127.0.0.1:9321/json/list')).json();
const room=targets.find(target=>target.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(room,'The local Electron app must be running');
const socket=new WebSocket(room.webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Division schedule inspection timed out')),120000);
    socket.addEventListener('message',event=>{
      const response=JSON.parse(event.data);
      if(response.id!==1)return;
      clearTimeout(timer);
      if(response.error||response.result.exceptionDetails)reject(new Error('Division schedule inspection failed'));
      else resolve(response.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,expression:
      `(async()=>{let board;const deadline=Date.now()+90000;do{board=await fetch('/api/games').then(r=>r.json());
          const game=board.games.find(g=>g.id===${JSON.stringify(gameId)});
          if(game?.home?.membership?.subdivision==='d2-d3'&&game?.away?.membership?.subdivision==='d2-d3')break;
          if(Date.now()<deadline)await new Promise(r=>setTimeout(r,1000));
        }while(Date.now()<deadline);const sources=await fetch('/api/sources').then(r=>r.json());
        return {at:Date.now(),games:board.games.length,lower:board.games.filter(g=>g.partitions?.includes('d2-d3')).map(g=>({
          id:g.id,name:g.name,date:g.date,lifecycle:g.lifecycle,partitions:g.partitions,
          home:{id:g.home.id,membership:g.home.membership},away:{id:g.away.id,membership:g.away.membership}})),
          coverage:board.leagues.ncaaf,capacity:sources.checks.limit,
          sportsurge:sources.sources.filter(s=>s.id==='sportsurge').map(s=>({matched:s.matchedGameCount,unmatched:s.unmatchedListingCount,reasons:s.unmatchedReasons})),
          workingGames:sources.games.filter(g=>board.games.some(b=>b.id===g.gameId&&b.partitions?.includes('d2-d3'))).map(g=>({gameId:g.gameId,name:g.name,choices:g.workingChoiceCount,feeds:g.candidates.length}))};})()`}}));
  });
  await writeFile(process.argv[2]??'.desktop-runtime/cold-start-20261017/college-divisions-electron.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({games:result.games,lower:result.lower.length,capacity:result.capacity,sportsurge:result.sportsurge,
    workingLower:result.workingGames.filter(game=>game.choices>0).length,expected:result.lower.find(game=>game.id===gameId)}));
  const actual=result.lower.find(game=>game.id===gameId);
  assert.ok(actual,'The official upcoming Division II/III event must appear in Electron');
  assert.equal(actual.date,expected.date);
  for(const side of ['home','away']){
    const competitor=expected.competitions[0].competitors.find(team=>team.homeAway===side);
    assert.equal(actual[side].id,`espn:ncaaf:${competitor.team.id}`);
    assert.equal(actual[side].membership?.subdivision,'d2-d3');
  }
  assert.ok(result.lower.length>1,'The app must include the combined division schedule');
}finally{socket.close();}
