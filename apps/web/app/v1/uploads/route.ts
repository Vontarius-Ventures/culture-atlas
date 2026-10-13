import { AppError, captures } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute, readImageField } from '@/lib/server/http';

export const POST = apiRoute(ROUTES.createUpload, async ({ ctx, body }) => {
  if (body.kind !== 'multipart') throw new AppError('invalid_input', { message: 'Send the photo as multipart/form-data.' });
  return captures.createUpload(ctx, await readImageField(body.form));
});
