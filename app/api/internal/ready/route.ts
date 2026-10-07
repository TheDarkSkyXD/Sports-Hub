export function HEAD(request: Request) {
  const controlToken = process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  const instanceId = process.env.SUNDAY_ROOM_SERVER_INSTANCE_ID;
  if (!controlToken || !instanceId || request.headers.get('x-sunday-control-token') !== controlToken)
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });

  return new Response(null, {
    status: 204,
    headers: { 'x-sunday-server-instance-id': instanceId, 'cache-control': 'no-store' },
  });
}
