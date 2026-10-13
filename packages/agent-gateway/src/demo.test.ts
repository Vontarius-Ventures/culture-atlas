import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ProviderError, type QlooEntity } from '@culture-atlas/providers';
import { FakeQloo, FakeTextModel } from '@culture-atlas/providers/testing';
import { agentConnections, collections, traces } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAccount, testConfig, testContext, testProviders } from '@culture-atlas/domain/testing';
import { runJob } from '../../domain/src/test-support/library';
import { runDemo } from '../../../apps/demo-agent/src/demo';
import { buildLibrary, connect, mcpClient } from './test-helpers';

/**
 * End to end over MCP: the independent demo agent reads a granted collection,
 * starts related discovery, creates a movie night and replaces its film,
 * while a background loop plays the worker. Then the owner's demo inspector
 * shows the agent's calls, Qloo queries and recommendations for those jobs.
 */

const db = getTestDb();
afterAll(closeTestDb);

const entity = (id: string, name: string, extra: Partial<QlooEntity> = {}): QlooEntity => ({
  entity_id: id,
  name,
  types: [],
  properties: {},
  tags: [],
  ...extra,
});

function liveQloo(prefix: string) {
  return new FakeQloo(
    {
      search: (q) => [entity(`ent-${q.toLowerCase().replace(/\W+/g, '-')}`, q)],
      insights: (req) => {
        const signals = req.signalEntities ?? [];
        if (req.filterType === 'urn:entity:movie') {
          return {
            entities: Array.from({ length: 8 }, (_, i) =>
              entity(`${prefix}-movie-${i}`, `Film ${prefix} ${i}`, {
                properties: { release_year: 1960 + i },
                query: { affinity: 0.9 - i / 20, explainability: signals.map((id) => ({ entity_id: id, score: 0.5 })) },
              }),
            ),
            tags: [],
          };
        }
        if (req.filterType === 'urn:entity:artist') {
          return { entities: Array.from({ length: 6 }, (_, i) => entity(`${prefix}-artist-${i}`, `Artist ${prefix} ${i}`)), tags: [] };
        }
        return {
          entities: [entity(`${prefix}-place`, 'Some place')],
          tags: [{ id: 'urn:tag:cuisine:japanese', name: 'Japanese', type: 'urn:tag:cuisine' }],
        };
      },
    },
    { live: true },
  );
}

function composerModel() {
  return new FakeTextModel((req) => {
    switch (req.schemaName) {
      case 'film_ideas':
        return { films: [{ title: 'Creative Film One', year: 1999, inputs: ['i1'], reason: 'Same warm light.' }] };
      case 'artist_ideas':
        return { artists: [{ name: 'Creative Artist A', inputs: ['i1'], reason: 'Close to your saved artist.' }] };
      case 'dish_ideas':
        return {
          dishes: [
            { title: 'Onigiri', description: 'Rice balls with pickled plum.', cuisine: 'Japanese', ingredients: ['rice'], inputs: ['i1'], reason: 'Simple finger food.' },
            { title: 'Miso eggplant', description: 'Roasted eggplant.', cuisine: 'Japanese', ingredients: ['eggplant'], inputs: ['i1'], reason: 'Echoes the café.' },
          ],
        };
      case 'plan_prose':
        return { title: 'A warm night in', summary: 'Your café photo and a saved artist.', rationale: null };
      default:
        return new ProviderError('text', 'server', `unexpected schema ${req.schemaName}`);
    }
  });
}

/** Plays the worker: runs queued jobs of one account until stopped. */
function backgroundWorker(accountId: string, providers: ReturnType<typeof testProviders>) {
  let stop = false;
  const errors: unknown[] = [];
  const loop = (async () => {
    while (!stop) {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM jobs WHERE owner_account_id = $1 AND state = 'queued' ORDER BY created_at LIMIT 5`,
        [accountId],
      );
      for (const r of rows) {
        try {
          await runJob(r.id, { providers });
        } catch (err) {
          errors.push(err);
        }
      }
      await new Promise((res) => setTimeout(res, 20));
    }
  })();
  return {
    errors,
    async stop() {
      stop = true;
      await loop;
    },
  };
}

describe('independent demo agent over MCP', () => {
  it('reads a granted collection, discovers related items, creates a plan and replaces the film', async () => {
    const lib = await buildLibrary({ demoOwner: true });
    const c = await connect(lib, { client_name: 'demo agent', scopes: ['collections:read', 'taste:read', 'plans:read', 'plans:write'] });
    const providers = testProviders({ qloo: liveQloo(randomUUID().slice(0, 6)), composer: composerModel() });
    const worker = backgroundWorker(lib.owner.accountId, providers);
    const lines: string[] = [];
    const client = await mcpClient(c.credential, providers);
    let result: Awaited<ReturnType<typeof runDemo>>;
    try {
      result = await runDemo(client, { log: (l) => lines.push(l), pollIntervalMs: 30, jobTimeoutMs: 20_000, collectionName: 'Tokyo evenings' });
    } finally {
      await client.close();
      await worker.stop();
    }
    expect(worker.errors).toEqual([]);
    if (process.env.DEMO_AGENT_PRINT) console.log(lines.join('\n'));

    // Every step is a printed service call.
    const tools = result.calls.map((x) => x.tool);
    for (const t of ['list_collections', 'get_collection', 'get_taste', 'discover_related', 'get_job', 'create_plan', 'get_plan', 'replace_plan_section']) {
      expect(tools).toContain(t);
    }
    expect(lines.filter((l) => l.startsWith('→ ')).length).toBe(result.calls.length);
    expect(result.collectionId).toBe(lib.granted.id);
    expect(result.relatedJob?.state).toMatch(/complete|partial/);

    // Boundary: global taste refused, collection taste allowed.
    expect(result.boundaryChecks).toEqual([
      { check: 'global taste', outcome: 'scope_denied' },
      { check: 'collection taste', outcome: 'visible' },
    ]);

    // The film section was replaced; food and music were preserved.
    const before = result.planBefore.active_version!;
    const after = result.planAfter.active_version!;
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.film?.feature?.title).toBeTruthy();
    expect(after.film?.feature?.title).not.toBe(before.film?.feature?.title);
    expect(after.food).toEqual(before.food);
    expect(after.music).toEqual(before.music);

    // Inspector for the replacement job: the agent's calls, Qloo queries and recommendations, no tokens.
    const ownerCtx = testContext(lib.owner, { providers });
    const trace = await traces.getTrace(ownerCtx, { job_id: result.replacementJobId });
    expect(trace.job).toMatchObject({ id: result.replacementJobId, type: 'replace_plan_section' });
    expect(trace.plan).toMatchObject({ id: result.planId, section: 'film' });
    expect(trace.plan!.inputs.length).toBeGreaterThanOrEqual(2);
    const agentTools = trace.agent_calls.map((a) => a.tool);
    expect(agentTools).toContain('replace_plan_section');
    expect(agentTools).toContain('get_job');
    expect(trace.agent_calls.every((a) => a.client_name === 'demo agent')).toBe(true);
    expect(trace.provider_queries.some((q) => q.provider === 'qloo' && q.status === 'ok' && !q.is_replay)).toBe(true);
    expect(trace.recommendations.some((r) => r.origin === 'qloo' && r.provider_query_ids.length > 0)).toBe(true);
    expect(trace.resolved_entities.some((e) => e.provider === 'qloo')).toBe(true);
    expect(JSON.stringify(trace)).not.toContain(c.credential);

    // Plan creation job trace includes create_plan.
    const planTrace = await traces.getTrace(ownerCtx, { job_id: result.planJobId });
    expect(planTrace.agent_calls.map((a) => a.tool)).toContain('create_plan');
  });

  it('removing a plan input from the granted collection hides the dependent plan from the agent immediately', async () => {
    const lib = await buildLibrary();
    const c = await connect(lib, { scopes: ['collections:read', 'plans:read', 'plans:write'] });
    const client = await mcpClient(c.credential);
    try {
      const created = await client.callTool<{ plan_id: string; job_id: string }>('create_plan', {
        collection_id: lib.granted.id,
        expected_revision: lib.granted.revision,
        item_ids: [lib.artist, lib.film],
        template: 'movie_night',
      });
      expect(created.ok).toBe(true);
      const planId = created.ok ? created.data.plan_id : '';
      const jobId = created.ok ? created.data.job_id : '';
      expect((await client.callTool('get_plan', { plan_id: planId })).ok).toBe(true);
      expect((await client.callTool('get_job', { job_id: jobId })).ok).toBe(true);

      await collections.removeCollectionItem(lib.ownerCtx, { id: lib.granted.id, item_id: lib.film });
      expect(await client.callTool('get_plan', { plan_id: planId })).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(await client.callTool('get_job', { job_id: jobId })).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(await client.callTool('replace_plan_section', { plan_id: planId, section: 'film' })).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      // The owner still sees it.
      const { rows } = await db.query('SELECT id FROM plans WHERE id = $1', [planId]);
      expect(rows).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});

/** One create_plan call by the agent over MCP; returns the job id. */
async function createPlanViaAgent(credential: string, lib: Awaited<ReturnType<typeof buildLibrary>>): Promise<string> {
  const client = await mcpClient(credential);
  try {
    const created = await client.callTool<{ job_id: string }>('create_plan', {
      collection_id: lib.granted.id,
      expected_revision: lib.granted.revision,
      item_ids: [lib.artist, lib.film],
      template: 'movie_night',
    });
    if (!created.ok) throw new Error(`create_plan failed: ${created.error.code}`);
    return created.data.job_id;
  } finally {
    await client.close();
  }
}

describe('demo inspector access', () => {
  it('is limited to the owning demo owner; agents, other accounts and non-demo owners get not_found', async () => {
    const lib = await buildLibrary({ demoOwner: true });
    const c = await connect(lib, { library_access: 'all', scopes: ['collections:read', 'plans:read', 'plans:write'] });
    const jobId = await createPlanViaAgent(c.credential, lib);
    const own = await traces.getTrace(testContext(lib.owner), { job_id: jobId });
    expect(own.agent_calls.map((a) => a.tool)).toEqual(['create_plan']);

    await expect(traces.getTrace(testContext(c.principal), { job_id: jobId })).rejects.toMatchObject({ code: 'not_found' });
    const stranger = await insertAccount(undefined, { isDemoOwner: true });
    await expect(traces.getTrace(testContext(stranger), { job_id: jobId })).rejects.toMatchObject({ code: 'not_found' });
    const plain = { ...lib.owner, isDemoOwner: false };
    await expect(traces.getTrace(testContext(plain), { job_id: jobId })).rejects.toMatchObject({ code: 'not_found' });
    // Allow-listed by configuration instead of the account flag.
    const viaConfig = testContext(plain, { config: testConfig({ DEMO_INSPECTOR_ACCOUNT_IDS: lib.owner.accountId }) });
    expect((await traces.getTrace(viaConfig, { job_id: jobId })).job.id).toBe(jobId);
  });

  it('revoking the connection keeps its past calls visible to the owner without the token', async () => {
    const lib = await buildLibrary({ demoOwner: true });
    const c = await connect(lib, { scopes: ['collections:read', 'plans:write'] });
    const jobId = await createPlanViaAgent(c.credential, lib);
    await agentConnections.revokeAgentConnection(lib.ownerCtx, { id: c.id });
    const trace = await traces.getTrace(testContext(lib.owner), { job_id: jobId });
    expect(trace.agent_calls).toHaveLength(1);
    expect(JSON.stringify(trace)).not.toMatch(/cat_[a-z0-9]+_[A-Za-z0-9_-]{8,}/);
  });
});
