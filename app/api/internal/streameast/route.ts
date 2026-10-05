import { command } from '@/lib/football/runtime/client';
import { StreameastCatalogSchema } from '@/lib/football/shared';

export const dynamic='force-dynamic';
const MAX_BODY_BYTES=8*1024*1024;

export async function POST(request:Request) {
  const secret=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  if(process.env.SUNDAY_ROOM_BROWSER_COLLECTORS!=='1'||!secret||request.headers.get('x-sunday-control-token')!==secret)
    return new Response(null,{status:404});
  if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json'||!request.body)
    return new Response(null,{status:415});
  const reader=request.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  try {
    while(true) {
      const next=await reader.read();
      if(next.done)break;
      size+=next.value.length;
      if(size>MAX_BODY_BYTES){await reader.cancel();return new Response(null,{status:413});}
      chunks.push(next.value);
    }
  } catch {await reader.cancel().catch(()=>{});return new Response(null,{status:400});}
  let input:unknown;
  try {input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{return new Response(null,{status:400});}
  if(!input||typeof input!=='object'||!('kind' in input)||input.kind!=='streameast-catalog'||!('catalog' in input))
    return new Response(null,{status:400});
  const parsed=StreameastCatalogSchema.safeParse(input.catalog);
  if(!parsed.success)return new Response(null,{status:400});
  const reply=await command({kind:'streameast-catalog',catalog:parsed.data});
  if(reply.kind==='catalog-ack')return Response.json(reply,{headers:{'Cache-Control':'no-store'}});
  return new Response(null,{status:reply.kind==='ok'?204:reply.kind==='error'?reply.status:502,headers:{'Cache-Control':'no-store'}});
}
