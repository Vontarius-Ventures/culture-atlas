import { getProviders, serveSignedMedia } from '@culture-atlas/providers';

/**
 * GET /v1/media?key=&exp=&sig= — serves private objects for the local/memory
 * storage drivers after verifying the HMAC signature and expiry (S3 uses
 * presigned URLs). Private, short cache headers; uniform 404 on any failure.
 */
export async function GET(request: Request) {
  return serveSignedMedia(getProviders().storage, new URL(request.url));
}
