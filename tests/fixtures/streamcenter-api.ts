import fixture from './source-api-review.json' with {type:'json'};

export function streamcenterApiReply(url:string,eventId:string,linkId:string,player:string):Response|null {
  const id=`event-espn-league-football-college-football-${eventId}`;
  if(url==='https://streamcenter.st/api/matches/football')return Response.json([
    {...fixture.matches[0],id,sources:[{source:'iframe',id}]},
  ]);
  if(url===`https://streamcenter.st/api/stream/iframe/${id}`)return Response.json([
    {...fixture.streams[0],id:linkId,embedUrl:player,webUrl:`https://streamcenter.st/watch/${id}`},
  ]);
  return null;
}
