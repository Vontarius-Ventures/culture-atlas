import { randomUUID } from 'node:crypto';
import { agentOAuth, AppError, enforceIpLimit, getDb, getDomainConfig, toErrorBody } from '@culture-atlas/domain';
import { abuseLimitIp } from '@/lib/server/http';

export async function POST(request: Request) {
  const requestId = randomUUID();
  const headers = { 'cache-control': 'no-store', pragma: 'no-cache' };
  try {
    const config = getDomainConfig(), db = getDb();
    await enforceIpLimit(db, { ip: abuseLimitIp(request, config), config, now: new Date() });
    const text = await request.text();
    if (text.length > 16_384) throw new AppError('payload_too_large');
    const body = request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text);
    const result = await agentOAuth.exchange(db, body, new Date());
    return Response.json(result, { headers });
  } catch (err) {
    const error = toErrorBody(err, requestId);
    return Response.json({ error: error.body }, { status: error.status, headers });
  }
}
