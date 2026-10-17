import { describe, expect, it } from 'vitest';
import { logEvent, redactSecrets, safeLogFields, setLogSink } from './log';

describe('log hygiene', () => {
  it('redacts credentials, signed URLs, callback fragments, emails and device tokens', () => {
    const raw = [
      'Bearer cat_abcdefghijklmnopqrstuvwxyz012345',
      'cna_' + 'A'.repeat(43),
      'cnr_' + 'B'.repeat(43),
      'cne_' + 'C'.repeat(43),
      'https://bucket.s3.amazonaws.com/k?X-Amz-Credential=AKIAABCDEFGHIJKLMNOP%2F&X-Amz-Signature=deadbeef',
      'https://atlas.example/identity/callback#challenge_id=1&token=secret',
      'person@example.com',
      'postgres://atlas:hunter2@db:5432/atlas',
      'ab'.repeat(32),
      'ca_session=abc123',
      'AKIAABCDEFGHIJKLMNOP',
    ].join(' ');
    const out = redactSecrets(raw);
    for (const secret of [
      'abcdefghijklmnopqrstuvwxyz012345',
      'A'.repeat(43),
      'B'.repeat(43),
      'C'.repeat(43),
      'deadbeef',
      'token=secret',
      'person@example.com',
      'hunter2',
      'ab'.repeat(32),
      'abc123',
      'AKIAABCDEFGHIJKLMNOP',
    ])
      expect(out).not.toContain(secret);
    // UUIDs stay readable for correlation.
    expect(redactSecrets('asset 00000000-0000-4000-8000-000000000001')).toContain(
      '00000000-0000-4000-8000-000000000001',
    );
  });

  it('drops non-allowlisted fields and non-primitive values', () => {
    expect(
      safeLogFields({
        command_id: 'c1',
        body: { email: 'x@y.z' },
        email: 'x@y.z',
        callback: 'https://a/b#token=1',
        count: 3,
        elapsed_ms: Number.NaN,
        reason: 'Bearer abc.def',
      }),
    ).toEqual({ command_id: 'c1', count: 3, reason: 'Bearer [redacted]' });
  });

  it('writes one JSON line with a safe event name', () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      logEvent('info', 'device_push', { outcome: 'sent', token: 'x' }, new Date(0));
      logEvent('warn', 'Bad Event Name!');
    } finally {
      setLogSink(undefined);
    }
    expect(JSON.parse(lines[0]!)).toEqual({
      time: '1970-01-01T00:00:00.000Z',
      level: 'info',
      event: 'device_push',
      outcome: 'sent',
    });
    expect(JSON.parse(lines[1]!).event).toBe('invalid_event_name');
  });
});
