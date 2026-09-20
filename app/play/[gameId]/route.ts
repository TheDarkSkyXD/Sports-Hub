import { GET as resolvePlayer } from '@/app/api/playback/route';
import { SOURCE, validSourcePage } from '@/lib/sunday';

export const dynamic = 'force-dynamic';

function unavailable(gameId: string, status: number, sourceUrl?: unknown) {
  const hasSource = typeof sourceUrl === 'string' && validSourcePage(sourceUrl);
  const source = hasSource ? sourceUrl : SOURCE;
  const retry = `/play/${encodeURIComponent(gameId)}`;
  const headline = status === 404 ? 'No player is listed yet.' : status === 400 ? 'We couldn’t find this game.' : 'Let’s get your game back.';
  const detail = status === 404 ? 'The provider hasn’t listed a player for this matchup. Try again shortly, or check the stream directory.' : 'This player couldn’t connect. Try this game again, or check the provider’s available streams.';
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>Sunday Room — Player connection</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#111216;color:#eef0f4;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;flex-direction:column}a{color:inherit;text-decoration:none}a:focus-visible{outline:3px solid #ffac99;outline-offset:5px}header{height:78px;padding:0 6vw;display:flex;align-items:center;border-bottom:1px solid #2c3038}.brand{display:inline-flex;align-items:center;gap:13px;font-size:15px;font-weight:700;letter-spacing:1.7px}.brand-light{font-weight:400;color:#b8bdc6}.brand-mark{display:grid;grid-template-columns:repeat(2,9px);gap:3px;transform:skew(-13deg)}.brand-mark i{width:9px;height:9px;background:#f0eee9;border-radius:1px}.brand-mark i:last-child{background:#ff8c77}main{flex:1;display:grid;place-items:center;padding:48px 24px}.card{width:100%;max-width:540px;background:#191c22;border:1px solid #363a45;border-radius:14px;padding:40px;box-shadow:0 24px 70px #0003}.connection-icon{width:54px;height:54px;display:grid;place-items:center;border:1px solid #65443e;border-radius:13px;color:#ffa38e;background:#342722;margin-bottom:28px}.eyebrow{font-size:10px;letter-spacing:1.8px;color:#e8a394;font-weight:600;margin:0 0 11px}h1{font-size:clamp(25px,5vw,32px);font-weight:600;line-height:1.2;letter-spacing:-1px;margin:0 0 17px}.description{font-size:14px;line-height:1.75;color:#aeb6c2;margin:0 0 29px}.actions{display:flex;gap:11px;flex-wrap:wrap}.button{min-height:43px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 16px;border:1px solid #454b57;border-radius:6px;font-size:12px;font-weight:600}.button:hover{background:#2b3039}.primary{background:#f28d79;border-color:#f28d79;color:#231816}.primary:hover{background:#ffa58f;border-color:#ffa58f}.return-link{display:inline-flex;margin-top:29px;color:#aeb6c2;font-size:12px;text-decoration:underline;text-underline-offset:4px}.return-link:hover{color:#f1f2f6}footer{padding:22px;text-align:center;font-size:11px;color:#7f8896}@media(max-width:480px){header{height:68px;padding:0 24px}main{padding:30px 18px}.card{padding:28px 24px}.actions{flex-direction:column}.button{width:100%}}
</style></head><body>
<header><a class="brand" href="/" aria-label="Sunday Room home"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span>SUNDAY<span class="brand-light">ROOM</span></span></a></header>
<main><section class="card" aria-labelledby="connection-title"><div class="connection-icon" aria-hidden="true"><svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><circle cx="12" cy="20" r=".7" fill="currentColor"/></svg></div><p class="eyebrow">PLAYER CONNECTION</p><h1 id="connection-title">${headline}</h1><p class="description">${detail}</p>
<div class="actions"><a class="button primary" href="${retry}">Retry this game <span aria-hidden="true">↻</span></a><a class="button" href="${source}" rel="noreferrer">${hasSource ? 'Open game source' : 'Stream directory'} <span aria-hidden="true">↗</span></a></div><a class="return-link" href="/">Back to your room</a></section></main><footer>Sunday Room · Made for your Sundays.</footer>
</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request, context: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await context.params;
  const url = new URL('/api/playback', request.url);
  url.searchParams.set('game', gameId);
  try {
    const result = await resolvePlayer(new Request(url));
    const data = await result.json();
    if (!result.ok) return unavailable(gameId, result.status, data?.sourceUrl);
    const player = data?.players?.[0]?.url;
    // Redirect only to the provider player contract, never a request query URL.
    if (typeof player !== 'string' || !/^https:\/\/gooz\.aapmains\.net\/new-stream-embed\/\d+$/.test(player)) return unavailable(gameId, 502, data?.sourceUrl);
    return new Response(null, { status: 303, headers: { Location: player, 'Cache-Control': 'no-store' } });
  } catch {
    return unavailable(gameId, 502);
  }
}
