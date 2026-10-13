import type { ObjectStorage } from './types';

/**
 * GET /v1/media handler body for drivers that sign their own links (local,
 * memory). Every failure is a uniform 404 so a link never reveals whether a
 * private object exists. Responses are private and cached no longer than the
 * link stays valid.
 */
export async function serveSignedMedia(storage: ObjectStorage, url: URL, nowMs: number = Date.now()): Promise<Response> {
  const notFound = () =>
    new Response(JSON.stringify({ code: 'not_found', message: 'Not found.', retryable: false, request_id: crypto.randomUUID() }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  if (!storage.verifySignedRequest) return notFound();
  const check = storage.verifySignedRequest(url.searchParams, nowMs);
  if (!check.ok) return notFound();
  const object = await storage.get(check.key);
  if (!object) return notFound();
  const exp = Number(url.searchParams.get('exp'));
  const maxAge = Math.max(0, Math.min(300, Math.floor(exp - nowMs / 1000)));
  return new Response(Buffer.from(object.body), {
    status: 200,
    headers: {
      'content-type': object.contentType,
      'content-length': String(object.body.byteLength),
      'cache-control': `private, max-age=${maxAge}`,
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}
