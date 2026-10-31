import { getDomainConfig, getVisualReferenceImage } from '@culture-atlas/domain';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ hash: string }> }): Promise<Response> {
  const { hash } = await context.params;
  const image = await getVisualReferenceImage(getDomainConfig(), hash);
  if (!image) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      'Content-Type': image.contentType,
      'Content-Length': String(image.bytes.length),
      'Cache-Control': 'public, max-age=3600, immutable',
      'ETag': `"${hash}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
