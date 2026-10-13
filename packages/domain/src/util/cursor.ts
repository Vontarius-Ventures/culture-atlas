import { type z } from 'zod';
import { AppError } from '../errors';

/** Opaque base64url JSON cursors. Validate decoded content with a schema. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T extends z.ZodType>(cursor: string, schema: T): z.infer<T> {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new AppError('invalid_input', { message: 'The cursor is not valid.' });
  }
}
