import { afterAll, describe, expect, it } from 'vitest';
import { analyses, captures, getJobById, references, type ServiceContext } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, testConfig } from '@culture-atlas/domain/testing';
import { ProviderError, UnavailableVlm, type VlmProvider } from '@culture-atlas/providers';
import { FakeTextModel } from '@culture-atlas/providers/testing';
import { anonCtx, accountCtx, runJobs, testJpeg, vlmFixture, world } from './test-world';

const db = getTestDb();
afterAll(closeTestDb);

async function submit(ctx: ServiceContext, bytes?: Uint8Array) {
  return captures.createCapture(ctx, { kind: 'multipart', image: { bytes: bytes ?? (await testJpeg()) }, fields: { source: 'upload', focus: undefined } });
}

async function recRows(captureId: string) {
  const { rows } = await db.query<{ id: string; category: string; origin: string; title: string; provider_query_ids: string[]; contributing_reference_ids: string[]; rank: number }>(
    `SELECT r.id, r.category, r.origin, r.title, r.provider_query_ids, r.contributing_reference_ids, r.rank
       FROM recommendations r JOIN analyses a ON a.id = r.analysis_id
      WHERE a.capture_id = $1 ORDER BY r.rank`,
    [captureId],
  );
  return rows;
}

describe('cultural compilation pipeline (worker + fakes)', () => {
  it('compiles a capture end to end with Qloo-grounded, sourced, progressive results', async () => {
    const { providers, vlm } = world();
    const ctx = await anonCtx(providers);
    const { capture_id, job_id, reused } = await submit(ctx);
    expect(reused).toBe(false);
    await runJobs(ctx, [job_id]);

    const job = await getJobById(db, job_id);
    expect(job?.state).toBe('complete');
    expect(job?.result_id).toBe(capture_id);
    expect(vlm.calls).toHaveLength(1);

    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.status).toBe('ready');
    expect(view.analysis).toMatchObject({ version: 1, title: 'Vintage racing references', interpretation: 'A few vintage racing references stood out.', warnings: [] });
    expect(view.analysis!.sections).toMatchObject({ observations: 'complete', references: 'complete', research: 'complete', wear: 'complete', play: 'complete', watch: 'complete', eat: 'complete' });
    expect(view.job_id).toBeNull();

    // Guardrails (quality plan §4): this single full reading has no stage 2, so the brand it read
    // (a held claim in a two-stage reading) is dropped before resolution, never published.
    expect(view.references.find((r) => r.name === 'Fixture Denim Co')).toBeUndefined();
    const { rows: guardTrace } = await db.query<{ data: { version: string; decisions: { name: string; action: string; rules: string[]; note?: string }[] } }>(
      `SELECT data FROM trace_events WHERE job_id = $1 AND name = 'guard'`,
      [job_id],
    );
    expect(guardTrace).toHaveLength(1);
    expect(guardTrace[0]!.data.version).toBe('guard-v2');
    expect(guardTrace[0]!.data.decisions.find((d) => d.name === 'Fixture Denim Co')).toMatchObject({ action: 'drop', rules: ['G-BRAND'], note: 'no_stage_2' });
    // References: resemblances are qualified.
    const racing = view.references.find((r) => r.name === 'Vintage Racing')!;
    expect(racing).toMatchObject({ relation: 'resembles', qualified: true, has_page: true });

    // Recommendations: <= 3 per category, <= 12 total, interleaved, never an anchor itself.
    const recs = view.recommendations;
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.length).toBeLessThanOrEqual(12);
    for (const c of ['wear', 'play', 'watch', 'eat']) expect(recs.filter((r) => r.category === c).length).toBeLessThanOrEqual(3);
    // A card named like a reference can only be that reference's own style direction (Wear).
    for (const r of recs.filter((x) => view.references.some((ref) => ref.name === x.title))) expect(r.subtitle).toBe('Style direction');
    expect(recs.map((r) => r.title)).not.toContain('Ungrounded Dish');
    expect(recs.every((r) => r.is_example === false)).toBe(true);
    for (let i = 2; i < recs.length; i++) expect(recs[i]!.category === recs[i - 1]!.category && recs[i]!.category === recs[i - 2]!.category).toBe(false);
    expect(new Set(view.available_categories)).toEqual(new Set(['wear', 'play', 'watch', 'eat']));
    expect(recs.find((r) => r.title === 'Fixture Film One')?.subtitle).toBe('1966');

    // Qloo grounding: every qloo-origin recommendation cites a real returned candidate.
    const rows = await recRows(capture_id);
    for (const r of rows.filter((x) => x.origin === 'qloo')) {
      const { rows: pq } = await db.query<{ provider: string; results: unknown; analysis_id: string }>('SELECT provider, results, analysis_id FROM provider_queries WHERE id = ANY($1::uuid[])', [r.provider_query_ids]);
      expect(pq.length).toBeGreaterThan(0);
      expect(pq[0]!.provider).toBe('qloo');
      expect(JSON.stringify(pq[0]!.results)).toContain(r.title);
    }
    // Eat is a creative suggestion tied to a supported reference, labeled internally.
    const dish = rows.find((r) => r.category === 'eat')!;
    expect(dish).toMatchObject({ origin: 'vlm_creative', title: 'Fixture Spritz Bites' });
    expect(dish.contributing_reference_ids.length).toBe(1);

    // Budget: at most 12 Qloo requests.
    const { rows: q } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id WHERE a.capture_id = $1 AND pq.provider = 'qloo'`, [capture_id]);
    expect(q[0]!.n).toBeLessThanOrEqual(12);

    // Reference page: sourced claims only, public facts.
    const page = await references.getReference(ctx, { id: racing.id, capture_id });
    expect(page.research_status).toBe('complete');
    expect(page.overview).toBe('Vintage Racing is a test reference.');
    expect(page.claims.filter((c) => c.claim_type === 'factual').every((c) => c.source_ids.length > 0)).toBe(true);
    expect(page.sources[0]!.url).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//);
    expect(page.related.length).toBeGreaterThan(0);

    // Uploading never changes taste.
    const { rows: prefs } = await db.query('SELECT 1 FROM preference_events WHERE owner_session_id = $1', [(ctx.principal as { sessionId: string }).sessionId]);
    expect(prefs).toHaveLength(0);
  });

  it('never shows a dietary safety promise in an Eat reason (the composer text is filtered as in plans)', async () => {
    const composer = new FakeTextModel((req) => {
      const refs = JSON.parse(req.prompt.split('\n')[2]!) as { name: string }[];
      return {
        dishes: [
          { name: 'Fixture Safe Bites', cuisine: 'Italian', reason: 'Completely nut-free and safe for allergies. A nod to the aperitivo mood.', reference_names: [refs[0]!.name] },
          { name: 'Fixture Free Plate', cuisine: 'Italian', reason: 'Allergen-free.', reference_names: [refs[0]!.name] },
        ],
      };
    });
    const { providers } = world({ overrides: { composer } });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const { rows } = await db.query<{ title: string; display_reason: string }>(
      `SELECT r.title, r.display_reason FROM recommendations r JOIN analyses a ON a.id = r.analysis_id
        WHERE a.capture_id = $1 AND r.category = 'eat' ORDER BY r.rank`,
      [capture_id],
    );
    expect(rows.map((r) => r.title)).toEqual(['Fixture Safe Bites', 'Fixture Free Plate']);
    expect(rows[0]!.display_reason).toBe('A nod to the aperitivo mood.');
    expect(rows[1]!.display_reason).toBe('A dish idea inspired by a reference in your photo.');
    for (const r of rows) expect(r.display_reason).not.toMatch(/free|safe for/i);
  });

  it('keeps reference results and marks discoveries unavailable when Qloo is not configured (no fabrication)', async () => {
    const { providers } = world({ qloo: null });
    expect(providers.capabilities()['qloo.insights']).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    expect((await getJobById(db, job_id))?.state).toBe('partial');
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.status).toBe('partial');
    expect(view.analysis!.sections).toMatchObject({ wear: 'unavailable', play: 'unavailable', watch: 'unavailable' });
    expect(view.analysis!.warnings).toContainEqual({ code: 'discoveries_delayed', message: 'Related discoveries are taking longer.' });
    // The brand of this single reading is dropped by G-BRAND (no stage 2); the rest stays unmatched.
    expect(view.references.map((r) => r.name)).toEqual(['1960s motor racing style', 'Italian aperitivo culture']);
    expect(view.references.every((r) => r.qualified)).toBe(true); // unmatched -> qualified
    const rows = await recRows(capture_id);
    expect(rows.filter((r) => r.origin === 'qloo' || r.origin === 'replay')).toHaveLength(0);
    const { rows: pq } = await db.query(`SELECT 1 FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id WHERE a.capture_id = $1 AND pq.provider = 'qloo'`, [capture_id]);
    expect(pq).toHaveLength(0);
  });

  it('a rate-limited category fails alone; completed categories stay published', async () => {
    const { providers } = world({ qloo: { failInsights: { 'urn:entity:movie': new ProviderError('qloo', 'rate_limited', '429', { status: 429, retryAfterMs: 60_000 }) } } });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    expect((await getJobById(db, job_id))?.state).toBe('partial');
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.analysis!.sections.watch).toBe('failed');
    expect(view.analysis!.sections.wear).toBe('complete');
    expect(view.recommendations.some((r) => r.category === 'watch')).toBe(false);
    expect(view.recommendations.some((r) => r.category === 'play')).toBe(true);
    const { rows } = await db.query<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id WHERE a.capture_id = $1 AND pq.operation = 'insights' AND pq.status = 'error'`,
      [capture_id],
    );
    expect(rows).toEqual([{ status: 'error', error_code: 'rate_limited' }]);
  });

  it('empty provider results produce no cards rather than invented ones', async () => {
    const { providers } = world({ qloo: { emptyInsights: true } });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.recommendations.filter((r) => r.category === 'play' || r.category === 'watch')).toHaveLength(0);
    // Wear may still show the resolved style direction (a real returned tag).
    expect(view.recommendations.filter((r) => r.category === 'wear').map((r) => r.title)).toEqual(['Vintage Racing']);
  });

  it('enforces the per-job Qloo request budget and skips lower-priority work', async () => {
    const { providers } = world();
    const ctx = await anonCtx(providers, testConfig({ JOB_MAX_QLOO_REQUESTS: '4' }));
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const { rows } = await db.query<{ n: number }>(
      `SELECT COALESCE(SUM((pq.query_context->>'attempts')::int), 0)::int AS n FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id WHERE a.capture_id = $1 AND pq.provider = 'qloo'`,
      [capture_id],
    );
    expect(rows[0]!.n).toBeLessThanOrEqual(4);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(Object.values(view.analysis!.sections)).toContain('skipped');
  });

  it('blurred photos return guidance and no discoveries', async () => {
    const { providers } = world({ vlm: vlmFixture('blurred.json') });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.analysis!.warnings).toContainEqual({ code: 'unclear_photo', message: 'Try a clearer photo, or tell us what caught your eye.' });
    expect(view.recommendations).toHaveLength(0);
    expect(view.status).toBe('ready');
  });

  it('competing subjects produce one optional "What caught your eye?" question', async () => {
    const { providers } = world({ vlm: vlmFixture('ambiguous-room.json') });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.analysis!.question).toEqual({
      prompt: 'What caught your eye?',
      choices: [
        { id: 's1', label: 'The lounge chair' },
        { id: 's2', label: 'The wall hanging' },
        { id: 's3', label: 'The record player' },
      ],
      whole_photo_choice_id: 'whole',
    });
    // The result is still useful without answering.
    expect(view.recommendations.length).toBeGreaterThan(0);
  });

  it('adversarial image text never triggers actions', async () => {
    const { providers } = world({ vlm: vlmFixture('adversarial-text.json') });
    const ctx = await accountCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.status).not.toBe('deleted');
    expect(view.recommendations.map((r) => r.title)).not.toContain('Fixture Brand X');
    const accountId = (ctx.principal as { accountId: string }).accountId;
    const { rows } = await db.query(`SELECT 1 FROM saved_items WHERE owner_account_id = $1 UNION ALL SELECT 1 FROM preference_events WHERE owner_account_id = $1`, [accountId]);
    expect(rows).toHaveLength(0);
  });

  it('filters items the owner hid before presentation', async () => {
    const { providers } = world();
    const ctx = await anonCtx(providers);
    const sessionId = (ctx.principal as { sessionId: string }).sessionId;
    await db.query(`INSERT INTO item_exclusions (owner_session_id, canonical_key) VALUES ($1, 'qloo:FIXTURE-MOVIE-0001')`, [sessionId]);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view.recommendations.map((r) => r.title)).not.toContain('Fixture Film One');
    expect(view.recommendations.map((r) => r.title)).toContain('Fixture Film Two');
  });

  it('reuses the same job for a duplicate submission and completed stages on a retried attempt', async () => {
    const { providers, vlm } = world();
    const ctx = await anonCtx(providers);
    const bytes = await testJpeg();
    const first = await submit(ctx, bytes);
    const again = await submit(ctx, bytes);
    expect(again).toEqual({ ...first, reused: true });
    await runJobs(ctx, [first.job_id]);
    const before = await recRows(first.capture_id);

    // Simulate a lost lease after completion: the job runs again.
    await db.query(`UPDATE jobs SET state = 'queued', lease_owner = NULL, finished_at = NULL, max_attempts = 5 WHERE id = $1`, [first.job_id]);
    await runJobs(ctx, [first.job_id]);
    expect(vlm.calls).toHaveLength(1); // observe output reused from job_stages
    const after = await recRows(first.capture_id);
    expect(after.map((r) => r.title)).toEqual(before.map((r) => r.title)); // no duplicates
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM discovery_items WHERE owner_session_id = $1 AND kind = 'film'`, [(ctx.principal as { sessionId: string }).sessionId]);
    expect(rows[0]!.n).toBe(2);
  });

  it('a delete during a running job prevents publication and removes private data', async () => {
    let ctxRef: ServiceContext | null = null;
    let captureId = '';
    const deletingVlm: VlmProvider = {
      id: 'vlm:deleting',
      capability: () => ({ status: 'available' }),
      async analyzeImage() {
        await captures.deleteCapture(ctxRef!, { id: captureId });
        return { analysis: vlmFixture('clear-outfit.json'), model: 'fake', durationMs: 1 };
      },
    };
    const { providers } = world({ overrides: { vlm: deletingVlm } });
    const ctx = await anonCtx(providers);
    ctxRef = ctx;
    const { capture_id, job_id } = await submit(ctx);
    captureId = capture_id;
    const key = (await db.query<{ private_object_key: string }>('SELECT private_object_key FROM captures WHERE id = $1', [capture_id])).rows[0]!.private_object_key;
    await runJobs(ctx, [job_id]);

    expect((await getJobById(db, job_id))?.state).toBe('cancelled');
    await expect(captures.getCapture(ctx, { id: capture_id })).rejects.toMatchObject({ code: 'not_found' });
    const { rows } = await db.query<{ status: string; deleted_at: Date | null; purge_after: Date | null; private_object_key: string | null }>('SELECT status, deleted_at, purge_after, private_object_key FROM captures WHERE id = $1', [capture_id]);
    expect(rows[0]).toMatchObject({ status: 'deleted', private_object_key: null });
    expect(rows[0]!.purge_after).not.toBeNull();
    expect((await db.query('SELECT 1 FROM analyses WHERE capture_id = $1', [capture_id])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM discovery_items WHERE capture_id = $1', [capture_id])).rows).toHaveLength(0);
    expect(await providers.storage.get(key)).toBeNull();
  });

  it('corrections queue a new analysis version without the rejected reference', async () => {
    const { providers, vlm } = world();
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const view = await captures.getCapture(ctx, { id: capture_id });
    const racing = view.references.find((r) => r.name === 'Vintage Racing')!;

    await expect(analyses.submitCorrection(ctx, { id: capture_id, body: { expected_analysis_version: 2, reject_reference_ids: [racing.id] } })).rejects.toMatchObject({ code: 'conflict' });
    const res = await analyses.submitCorrection(ctx, { id: capture_id, body: { expected_analysis_version: 1, reject_reference_ids: [racing.id], replacement: { name: 'Fixture Denim Co', type: 'brand' } } });
    expect(res.pending_analysis_version).toBe(2);
    await runJobs(ctx, [res.job_id]);

    expect(vlm.calls[1]!.rejectedNames).toEqual(['Vintage Racing']);
    expect(vlm.calls[1]!.confirmedInterests).toEqual(['Fixture Denim Co']);
    const v2 = await captures.getCapture(ctx, { id: capture_id });
    expect(v2.analysis!.version).toBe(2);
    expect(v2.references.map((r) => r.name)).not.toContain('Vintage Racing');
    expect(v2.references.find((r) => r.name === 'Fixture Denim Co')?.relation).toBe('user_selected');
    const { rows } = await db.query<{ action: string }>(`SELECT action FROM preference_events WHERE target_id = $1`, [capture_id]);
    expect(rows).toEqual([{ action: 'correct' }]);
  });

  it('fails the capture visibly when the VLM is unavailable (not retried, nothing fabricated)', async () => {
    const { providers } = world({ vlm: () => new ProviderError('vlm', 'unavailable', 'no key') });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    const job = await getJobById(db, job_id);
    expect(job).toMatchObject({ state: 'failed', error_code: 'provider_unavailable', attempt: 1 });
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view).toMatchObject({ status: 'failed', analysis: null, recommendations: [] });
  });

  it('replays the reviewed example reading for an example photo when the VLM is unavailable (labeled, never Qloo)', async () => {
    const { providers } = world({ qloo: null, composer: false, overrides: { vlm: new UnavailableVlm('not_configured') } });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await captures.createCapture(ctx, { kind: 'json', body: { sample_id: 'outfit' } as never });
    await runJobs(ctx, [job_id]);
    expect((await getJobById(db, job_id))?.state).toBe('partial');
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view).toMatchObject({ is_example: true, status: 'partial' });
    expect(view.analysis).toMatchObject({ title: 'Vintage racing references' });
    expect(view.analysis!.warnings).toContainEqual({ code: 'discoveries_delayed', message: 'Related discoveries are taking longer.' });
    expect(view.references.every((r) => r.qualified)).toBe(true);
    expect(view.recommendations.map((r) => r.title)).toEqual(expect.arrayContaining(['Le Mans', 'Mod tailoring']));
    expect(view.recommendations.every((r) => r.is_example)).toBe(true);
    const rows = await recRows(capture_id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.origin === 'sample' && r.provider_query_ids.length === 0)).toBe(true);
    const { rows: pq } = await db.query<{ provider: string; is_replay: boolean }>(
      `SELECT pq.provider, pq.is_replay FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id WHERE a.capture_id = $1`,
      [capture_id],
    );
    expect(pq.filter((q) => q.provider === 'vlm')).toEqual([{ provider: 'vlm', is_replay: true }]);
    expect(pq.some((q) => q.provider === 'qloo')).toBe(false);
  });

  it('an anonymous example replays its reviewed reading when the only model is the account-budgeted gateway', async () => {
    const { providers, vlm } = world({ qloo: null, composer: false });
    // A usable model behind the Concentrate gateway, which never serves a job without an account.
    const gated = { ...providers, modelGateway: {} as NonNullable<typeof providers.modelGateway> };
    const ctx = await anonCtx(gated);
    const { capture_id, job_id } = await captures.createCapture(ctx, { kind: 'json', body: { sample_id: 'outfit' } as never });
    await runJobs(ctx, [job_id]);
    const view = await captures.getCapture(ctx, { id: capture_id });
    expect(view).toMatchObject({ is_example: true });
    expect(view.analysis).toMatchObject({ title: 'Vintage racing references' });
    expect(vlm.calls).toHaveLength(0);
  });

  it('never replays an example reading for an uploaded photo', async () => {
    const { providers } = world({ qloo: null, overrides: { vlm: new UnavailableVlm('not_configured') } });
    const ctx = await anonCtx(providers);
    const { capture_id, job_id } = await submit(ctx);
    await runJobs(ctx, [job_id]);
    expect(await getJobById(db, job_id)).toMatchObject({ state: 'failed', error_code: 'provider_unavailable' });
    expect(await captures.getCapture(ctx, { id: capture_id })).toMatchObject({ status: 'failed', analysis: null, recommendations: [] });
  });
});
