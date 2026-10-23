import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, ERROR_CODES, invalidInput, toErrorBody } from './errors';

describe('AppError', () => {
  it('maps spec codes to HTTP statuses', () => {
    expect(ERROR_CODES.invalid_input).toBe(400);
    expect(ERROR_CODES.unauthenticated).toBe(401);
    expect(ERROR_CODES.scope_denied).toBe(403);
    expect(ERROR_CODES.not_found).toBe(404);
    expect(ERROR_CODES.revision_conflict).toBe(409);
    expect(ERROR_CODES.payload_too_large).toBe(413);
    expect(ERROR_CODES.quota_exceeded).toBe(429);
    expect(ERROR_CODES.provider_unavailable).toBe(503);
  });

  it('produces the standard body {code,message,retryable,request_id}', () => {
    const { status, body } = toErrorBody(new AppError('rate_limited'), 'req-1');
    expect(status).toBe(429);
    expect(body).toEqual({ code: 'rate_limited', message: expect.any(String), retryable: true, request_id: 'req-1' });
  });

  it('carries the backoff hint as retry_after_ms when the error has one', () => {
    const { body } = toErrorBody(new AppError('rate_limited', { retryAfter: 60 }), 'req-3');
    expect(body).toMatchObject({ code: 'rate_limited', retryable: true, retry_after_ms: 60_000 });
    expect('retry_after_ms' in toErrorBody(new AppError('conflict'), 'req-4').body).toBe(false);
  });

  it('hides unknown errors behind internal', () => {
    const { status, body } = toErrorBody(new Error('db password=secret'), 'req-2');
    expect(status).toBe(500);
    expect(body.code).toBe('internal');
    expect(body.message).not.toContain('secret');
  });

  it('converts zod errors to invalid_input with field issues', () => {
    const r = z.strictObject({ name: z.string() }).safeParse({ name: 1, extra: true });
    expect(r.success).toBe(false);
    const err = invalidInput(r.error!);
    expect(err.status).toBe(400);
    expect(JSON.stringify(err.details)).toContain('name');
  });
});

describe('config', () => {
  it('treats empty env values (copied .env.example) as unset', async () => {
    const { loadDomainConfig } = await import('./config');
    const c = loadDomainConfig({ NODE_ENV: '', DATABASE_URL: '', WORKER_CONCURRENCY: '' });
    expect(c.NODE_ENV).toBe('development');
    expect(c.WORKER_CONCURRENCY).toBe(5);
    expect(c.DATABASE_URL).toContain('culture_atlas');
  });
});
