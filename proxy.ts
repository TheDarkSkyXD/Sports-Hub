import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const nonce = randomBytes(18).toString('base64');
  const development = process.env.NODE_ENV === 'development';
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data: blob:",
    "font-src 'self'",
    // CSP cannot match IPv6 host literals used by manual loopback feeds.
    `connect-src 'self' https: http:${development ? ' ws://127.0.0.1:* ws://localhost:*' : ''}`,
    "worker-src 'self' blob:",
    "media-src 'self' blob: https: http:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', policy);
  headers.set('x-nonce', nonce);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export const config = {
  matcher: '/((?!api|_next/static|_next/image|favicon.ico|favicon.svg|series-logos).*)',
};
