import { describe, expect, it } from 'vitest';
import { redactTraceData, summarizeProviderResults } from './traces';

describe('inspector redaction', () => {
  it('removes credentials, storage keys and private deployment urls', () => {
    const out = redactTraceData({
      headers: { 'X-Api-Key': 'secret-key' },
      url: 'http://10.0.0.5:8080/relay/assets',
      public: 'https://en.wikipedia.org/wiki/Tampopo',
      object_key: 'accounts/a/captures/c.jpg',
      note: 'called with Bearer abc.def',
      nested: [{ password: 'p', ok: 1 }],
    }) as Record<string, unknown>;
    expect(out.headers).toEqual({ 'X-Api-Key': '[redacted]' });
    expect(out.url).toBe('[private url]');
    expect(out.public).toBe('https://en.wikipedia.org/wiki/Tampopo');
    expect(out.object_key).toBe('[private]');
    expect(out.note).toBe('called with [redacted]');
    expect(out.nested).toEqual([{ password: '[redacted]', ok: 1 }]);
  });
});

describe('provider result summaries', () => {
  it('keeps rank order, ids, names and scores of the first ten results', () => {
    const results = {
      entities: Array.from({ length: 14 }, (_, i) => ({ entity_id: `e${i}`, name: `N${i}`, query: { affinity: 1 - i / 20 }, properties: { big: 'x'.repeat(500) } })),
    };
    const s = summarizeProviderResults(results) as { count: number; top: Record<string, unknown>[] };
    expect(s.count).toBe(14);
    expect(s.top).toHaveLength(10);
    expect(s.top[0]).toEqual({ rank: 1, entity_id: 'e0', name: 'N0', query: { affinity: 1 } });
    expect(JSON.stringify(s)).not.toContain('xxxx');
  });

  it('passes small unrecognized payloads through and truncates large ones', () => {
    expect(summarizeProviderResults({ ok: true })).toEqual({ ok: true });
    expect(summarizeProviderResults({ blob: 'z'.repeat(5000) })).toMatchObject({ truncated: true });
    expect(summarizeProviderResults(null)).toBeNull();
  });
});
