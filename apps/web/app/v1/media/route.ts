import { NextResponse } from 'next/server';

/**
 * GET /v1/media?key=&exp=&sig= — serves private objects for the LOCAL storage
 * driver after verifying the HMAC signature and expiry (S3 uses presigned URLs).
 * TODO(storage owner): implement; respond with private, short cache headers.
 */
export async function GET() {
  return NextResponse.json({ code: 'not_implemented', message: 'Media serving is not available yet.', retryable: false, request_id: crypto.randomUUID() }, { status: 501 });
}
