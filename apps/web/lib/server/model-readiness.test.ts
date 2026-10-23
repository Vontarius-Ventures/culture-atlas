import { describe, expect, it } from 'vitest';
import type { ModelGateway, ReadinessDetail, ModelRole } from '@culture-atlas/providers';
import { roleAvailability } from './model-readiness';

function gateway(detail: ReadinessDetail | Error): ModelGateway {
  return {
    readiness: async () => {
      if (detail instanceof Error) throw detail;
      return Object.fromEntries(
        (['vision_photo', 'vision_video_frame', 'research_text', 'composer'] as ModelRole[]).map(
          (role) => [role, { role, model: 'fixture/model-1', ...detail }],
        ),
      ) as Awaited<ReturnType<ModelGateway['readiness']>>;
    },
  } as unknown as ModelGateway;
}

describe('v2 analysis availability (read-only, no paid probe)', () => {
  it.each([
    [{ state: 'qualified' }, 'available'],
    [{ state: 'available' }, 'available'],
    [{ state: 'degraded', reason: 'rate_limited' }, 'waiting'],
    [{ state: 'unavailable', reason: 'credits' }, 'waiting'],
    [{ state: 'unavailable', reason: 'cost_overrun' }, 'waiting'],
    [{ state: 'unavailable', reason: 'auth' }, 'unavailable'],
    [{ state: 'unavailable', reason: 'policy' }, 'unavailable'],
    [{ state: 'unavailable', reason: 'not_configured' }, 'unavailable'],
    [{ state: 'configured', reason: 'not_qualified' }, 'unavailable'],
    [{ state: 'catalog-compatible', reason: 'not_qualified' }, 'unavailable'],
  ] as Array<[ReadinessDetail, string]>)('%j -> %s', async (detail, expected) => {
    await expect(roleAvailability('vision_photo', gateway(detail))).resolves.toBe(expected);
  });

  it('is unavailable on an explicit Featherless/Anthropic rollback or a readiness read failure', async () => {
    await expect(roleAvailability('vision_photo', undefined)).resolves.toBe('unavailable');
    await expect(roleAvailability('vision_photo', gateway(new Error('db down')))).resolves.toBe(
      'unavailable',
    );
  });
});
