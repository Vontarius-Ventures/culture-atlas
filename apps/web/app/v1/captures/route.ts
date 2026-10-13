import { AppError, captures, invalidInput } from '@culture-atlas/domain';
import { CreateCaptureJsonRequest, CreateCaptureMultipartFields, ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute, formFields, readImageField } from '@/lib/server/http';

export const POST = apiRoute(ROUTES.createCapture, async ({ ctx, body }) => {
  if (body.kind === 'multipart') {
    const fields = CreateCaptureMultipartFields.safeParse(formFields(body.form));
    if (!fields.success) throw invalidInput(fields.error);
    return captures.createCapture(ctx, { kind: 'multipart', image: await readImageField(body.form), fields: fields.data });
  }
  if (body.kind === 'json') {
    const parsed = CreateCaptureJsonRequest.safeParse(body.json);
    if (!parsed.success) throw invalidInput(parsed.error);
    return captures.createCapture(ctx, { kind: 'json', body: parsed.data });
  }
  throw new AppError('invalid_input', { message: 'Attach a photo or pass upload_id / sample_id.' });
});
