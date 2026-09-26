import { streamToken } from '@/lib/stream-server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  return streamToken(token, request.headers.get('range'));
}
