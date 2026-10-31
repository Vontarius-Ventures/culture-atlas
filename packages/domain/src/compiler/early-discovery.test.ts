import { describe, expect, it, vi } from 'vitest';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { StyleStage, type StyleHost } from './style-stage';
import { CaptureCompiler } from './analyze';
import type { JobContext } from '../jobs/handler';

describe('early entity discovery prefetch', () => {
  it('waits for a subject rather than an early rail, and respects a bounded timeout', async () => {
    const stage = new StyleStage({} as StyleHost);
    const internals = stage as unknown as { subjectReady: { resolve(): void }; primary: { resolve(): void } };
    let ready = false;
    const wait = stage.waitForSubject(100).then(() => { ready = true; });
    internals.primary.resolve();
    await Promise.resolve();
    expect(ready).toBe(false);
    internals.subjectReady.resolve();
    await wait;
    expect(ready).toBe(true);
    await expect(new StyleStage({} as StyleHost).waitForSubject(1)).resolves.toBeUndefined();
  });

  it.each(['pending', 'running'])('the cross-domain compiler cannot bypass an enabled %s subject reader with reference fallback', async (sectionStatus) => {
    const insights = vi.fn();
    const db = { query: vi.fn() };
    const ctx = { budget: { deadlineMs: 60_000 }, job: { trace_id: null }, providers: { qloo: { insights } }, db } as unknown as JobContext<'analyze_capture'>;
    const compiler = new CaptureCompiler(ctx);
    const internal = compiler as unknown as {
      style: { reading: null; sectionStatus: string }; stylePlan: { enabled: boolean };
      recommend: (category: string, refs: unknown[], usable: boolean) => Promise<unknown>;
    };
    internal.style = { reading: null, sectionStatus };
    internal.stylePlan = { enabled: true };
    expect(await internal.recommend('watch', [{ referenceId: 'ref', qloo: { tagId: 'real-tag' } }], true)).toMatchObject({ status: 'skipped', reason: 'subject_not_ready', candidates: [] });
    expect(insights).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each(['urn:entity:brand', 'urn:entity:movie', 'urn:entity:artist'])('%s never publishes or creates a bridge before the real subject is known', async (type) => {
    const qloo = new FakeQloo({
      insights: () => ({ entities: [{ entity_id: 'candidate', name: 'Fixture neighbour', types: [type], properties: {}, tags: [], query: { affinity: 0.9 } }], tags: [] }),
    }, { live: true });
    const query = vi.fn(async (sql: string) => {
      // Logging is permitted, publishing is not. The old movie/artist early path
      // attempted a capture transaction and recommendation inserts here.
      expect(sql).toContain('INSERT INTO provider_queries');
      return { rows: [{ id: 'query-prefetch' }] };
    });
    const trace = vi.fn(async () => undefined);
    const host = {
      ctx: { providers: { qloo }, db: { query }, trace },
      analysisId: 'analysis', traceId: null, startedAt: Date.now(),
      budget: { remaining: () => 10 }, pastSoftDeadline: () => false,
      qlooCall: async (_stage: string, fn: (options: object) => Promise<unknown>) => ({ value: await fn({}), attempts: 1 }),
    } as unknown as StyleHost;
    const stage = new StyleStage(host);
    stage.startEarlyEntityRail([{ referenceId: 'reference', name: 'Fixture seed', entityId: 'seed', types: [type], boxes: [], tags: [] }]);
    await (stage as unknown as { earlyRail: Promise<void> }).earlyRail;
    expect(query).toHaveBeenCalledTimes(1);
    expect(stage.reading).toBeNull();
    expect(stage.bridges()).toEqual([]);
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ name: 'style:retrieval_admission', data: expect.objectContaining({ admission_status: 'held_until_subject', held_count: 1, admitted_count: 0, rejected_count: 0 }) }));
  });
});
