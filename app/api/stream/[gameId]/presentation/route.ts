import {streamPresentation} from '@/lib/stream-server';

export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{gameId:string}>}){
  const {gameId}=await params,query=new URL(request.url).searchParams;
  const intent=query.get('intent')??'primary';
  if(query.getAll('intent').length>1||intent!=='primary'&&intent!=='fallback')return new Response(null,{status:400});
  return streamPresentation({gameId,sessionId:query.get('session'),candidateId:query.get('candidate'),
    generation:query.get('generation'),intent,signal:request.signal});
}
