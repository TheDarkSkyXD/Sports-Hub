import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {tvappStreams} from '../lib/playback/providers/tvapp-catalog.ts';
import {catalogStreamProvider} from '../lib/playback/providers/catalog-stream.ts';
import {validStreamTarget} from '../lib/playback/providers/catalog-stream-policy.ts';

test('TVApp filters invalid rows while retaining the valid stream100 sibling',()=>{
  const row={id:'2123',source:'golf',streamNo:100,language:'English',hd:true,embedUrl:'https://embed.st/embed/golf/2123/100'};
  assert.deepEqual(tvappStreams([{...row,streamNo:101},row,{streamNo:'broken'}],'golf','2123'),[row]);
  assert.equal(validStreamTarget('streamed','golf','2123',100,row.embedUrl),true);
  assert.equal(validStreamTarget('streamed','golf','2123',101,'https://embed.st/embed/golf/2123/101'),false);
});

test('catalog playback revalidates a valid sibling instead of rejecting the entire mixed response',async()=>{
  const events=JSON.parse(readFileSync(new URL('./fixtures/broad-sources/streamed.json',import.meta.url),'utf8'));
  const event=events.find((value:{title:string})=>value.title==='Buffalo Sabres vs Dallas Stars');
  assert.ok(event);
  const url='https://embed.st/embed/golf/2123/100';
  const provider=catalogStreamProvider(async target=>Response.json(target.pathname==='/api/matches/all'?events:[
    {id:'2123',source:'golf',streamNo:100,embedUrl:url},
    {id:'2123',source:'golf',streamNo:101,embedUrl:'https://embed.st/embed/golf/2123/101'},
    {streamNo:'broken'},
  ]),async target=>({root:null,player:{url:target.href,referer:target.href},close(){}}));
  const playback=await provider.open({provider:'catalog-stream',source:'streamed',gameId:'401892458',eventId:event.id,
    eventUrl:`https://streamed.st/watch/${event.id}`,sourceName:'golf',sourceId:'2123',streamNo:100,
    kickoff:event.date,title:event.title,teams:[event.teams.home.name,event.teams.away.name]},new AbortController().signal);
  try{assert.equal(playback.player?.url,url);}finally{playback.close();}
});
