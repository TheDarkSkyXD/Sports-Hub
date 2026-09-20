import { GET as resolvePlayer } from '@/app/api/playback/route';
export const dynamic = 'force-dynamic';
export async function GET(request:Request, context:{params:Promise<{gameId:string}>}) {
 const {gameId}=await context.params;
 const url=new URL('/api/playback',request.url);url.searchParams.set('game',gameId);
 const result=await resolvePlayer(new Request(url));
 const data=await result.json();
 if(!result.ok)return new Response('<!doctype html><html><head><title>Sunday Room — Player unavailable</title></head><body style="background:#141519;color:#eee;font:18px system-ui;padding:48px"><h1>This player is temporarily unavailable.</h1><p>Please return to Sunday Room and try again shortly.</p><a href="/" style="color:#ff927c">Back to your room</a></body></html>',{status:result.status,headers:{'Content-Type':'text/html; charset=utf-8'}});
 return Response.redirect(data.players[0].url,303);
}
