import 'server-only';
import type { NextRequest } from 'next/server';
import { AppError, type CaptureV2Context } from '@culture-atlas/domain';

const WAV_TYPE = /^audio\/(wav|wave|x-wav)$/i;

export function isCreateAudioUpload(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && (body as { kind?: unknown }).kind === 'audio');
}

export async function audioAssetKind(
  ctx: CaptureV2Context,
  id: string,
): Promise<'audio' | 'other' | null> {
  const { rows } = await ctx.db.query<{ kind: string }>(
    `SELECT kind FROM media_assets WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [ctx.authority.accountId, id],
  );
  if (!rows[0]) return null;
  return rows[0].kind === 'audio' ? 'audio' : 'other';
}

/** Keep (POST /v2/media/audio): WAV/PCM bytes plus KeepAudioRecordingRequest fields. */
export async function readKeepAudioBody(
  request: NextRequest,
): Promise<{ meta: Record<string, unknown>; bytes: Uint8Array }> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('multipart/form-data')) {
    throw new AppError('invalid_input', {
      message: 'Keep a WAV recording as multipart form data.',
    });
  }
  const form = await request.formData();
  const file = form.get('recording') ?? form.get('file');
  if (!(file instanceof File) || file.size < 1) {
    throw new AppError('invalid_input', { message: 'Attach a WAV recording.' });
  }
  const namedWav = /\.wav$/i.test(file.name);
  if (file.type && !WAV_TYPE.test(file.type) && !namedWav) {
    throw new AppError('unsupported_media', {
      message: 'Use a WAV recording. Other audio containers are not qualified yet.',
    });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const meta: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key === 'recording' || key === 'file') continue;
    if (typeof value === 'string') meta[key] = value;
  }
  if (typeof meta.filename !== 'string' || !meta.filename) meta.filename = file.name || 'music-mode.wav';
  if (typeof meta.content_type !== 'string' || !meta.content_type) meta.content_type = 'audio/wav';
  return { meta, bytes };
}
