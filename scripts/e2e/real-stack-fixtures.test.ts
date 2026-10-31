import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captures, JOB_HANDLERS } from '../../packages/domain/src';
import { insertAccount, testConfig, testContext } from '../../packages/domain/src/testing';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../packages/domain/src/testing/isolated-db';
import {
  createProviderRegistry,
  QlooHttpProvider,
  UnavailableResearch,
  VlmStyleWireSchema,
  type StructuredTransport,
} from '../../packages/providers/src';
import { createE2EModelTransport, E2E_MODEL_CATALOG, E2E_MODEL_PROFILES, E2E_STYLE_READING } from '../../apps/worker/src/e2e-fake-models';
import { Worker } from '../../apps/worker/src/worker';
import { fixtureQlooRoute } from './fake-qloo';

let isolated: IsolatedDatabase;
beforeAll(async () => { isolated = await createIsolatedDatabase('realstack'); });
afterAll(() => isolated?.drop());

describe('legacy v9 real-stack browser provider fixtures', () => {
  it('supplies the current independent style wire contract with no invented cross-domain aesthetics', () => {
    expect(VlmStyleWireSchema.safeParse(E2E_STYLE_READING).success).toBe(true);
    expect(E2E_STYLE_READING.subjects.map((subject) => subject.category)).toEqual(['food']);
    expect(E2E_STYLE_READING.claims).toEqual([]);
    expect(E2E_MODEL_PROFILES.vision_style.schemaVersion).toBe(E2E_STYLE_READING.schema);
  });

  it('publishes content-supported documentary fixtures through the real compiler, gateway and Qloo adapter, rejecting unsupported filler', async () => {
    const db = isolated.db;
    const schemas: string[] = [];
    const fake = createE2EModelTransport({ quick: 0, enrich: 0, style: 0 });
    const transport: StructuredTransport = (request, options) => {
      schemas.push(request.schemaName);
      return fake(request, options);
    };
    const qloo = new QlooHttpProvider({
      apiKey: 'fixture-no-network',
      baseUrl: 'https://fixture.invalid',
      timeoutMs: 1000,
      fetch: async (url) => {
        const response = fixtureQlooRoute(new URL(String(url)));
        return new Response(JSON.stringify(response.body), { status: response.status });
      },
    });
    const providers = createProviderRegistry({
      NODE_ENV: 'test',
      STORAGE_DRIVER: 'memory',
      LLM_PROVIDER: 'concentrate',
      CONCENTRATE_API_KEY: 'fixture-no-network',
      MODEL_DAILY_SPEND_LIMIT_USD: '10',
      MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD: '1',
      MODEL_MAX_UNKNOWN_SPEND_USD: '5',
    }, { qloo, research: new UnavailableResearch('not_configured') }, {
      db, profiles: E2E_MODEL_PROFILES, catalog: E2E_MODEL_CATALOG, transport, qualification: () => 'qualified',
    });
    // These recorded fake profiles predate the independent v10 asset role.
    // Keep the old contract explicit, not a fabricated v10 checker verdict.
    const ctx = testContext(await insertAccount(db), { db, providers,
      config: testConfig({ COMPILER_VERSION: 'compiler-2026-10-27-intent-quality-v9' }) });
    const submitted = await captures.createCapture(ctx, {
      kind: 'multipart',
      image: { bytes: readFileSync(new URL('../../apps/web/public/samples/onboarding/noodles.jpg', import.meta.url)) },
      fields: { source: 'upload', focus: undefined },
    });
    const worker = new Worker({
      db, providers, config: ctx.config, handlers: JOB_HANDLERS,
      jobIds: [submitted.job_id], log: () => undefined, heartbeatMs: 1000,
    });
    await worker.drain();
    const result = await captures.getCapture(ctx, { id: submitted.capture_id });
    expect(result.analysis?.title).toBe('Sesame noodle supper');
    expect(result.style_reading?.subjects[0]?.label).toBe('Bowl of noodles');
    expect(schemas).toContain(E2E_MODEL_PROFILES.vision_style.schemaVersion);
    const cards = result.recommendations;
    expect(cards.length, 'a terminal empty result must not pass the real-stack journey').toBeGreaterThan(0);
    expect(cards.map((card) => card.title)).toEqual(['Fixture Noodle Makers']);
    expect(cards[0]?.evidence_available).toBe(true);
    const proofs = await db.query<{ display_reason: string; style_match: { proof?: unknown }; provider_query_ids: string[] }>(
      `SELECT r.display_reason, r.style_match, r.provider_query_ids FROM recommendations r
       JOIN analyses a ON a.id = r.analysis_id WHERE a.capture_id = $1 AND r.category = 'watch'`,
      [submitted.capture_id],
    );
    expect(proofs.rows).toHaveLength(1);
    expect(proofs.rows[0]?.display_reason).toBe('Documentary on noodles; prompted by noodle dish appearance your photo may suggest');
    expect(proofs.rows[0]?.provider_query_ids.length).toBeGreaterThan(0);
    expect(JSON.stringify(proofs.rows[0]?.style_match)).toContain('about_subject');
    expect(JSON.stringify(proofs.rows[0]?.style_match)).toContain('short_description');
    expect(JSON.stringify(proofs.rows[0]?.style_match)).toContain('"topicPlanKey":"noodles"');
  });
});
