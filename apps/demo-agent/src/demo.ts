import type { ToolCaller, ToolError, ToolOutcome } from './client';

/**
 * The demo script: read a granted collection, discover related items, create
 * a movie night and replace its film section, printing every service call.
 * It also shows that the connection's boundary holds (global taste refused for
 * a selected-collection grant). Pure over a ToolCaller so tests can run it
 * against an in-process MCP endpoint.
 */

interface CardLike {
  id: string;
  kind: string;
  title: string;
}
interface CollectionSummaryLike {
  id: string;
  name: string;
  item_count: number;
  revision: number;
}
interface CollectionDetailLike {
  collection: CollectionSummaryLike;
  items: { item: CardLike }[];
}
interface JobLike {
  id: string;
  state: string;
  stage: string | null;
  poll_after_ms: number | null;
  error: ToolError | null;
}
interface FilmPickLike {
  title: string;
  year: number | null;
  reason: string | null;
}
interface PlanLike {
  id: string;
  status: string;
  active_version: {
    version: number;
    title: string | null;
    sections: Record<string, string>;
    film: { feature: FilmPickLike | null; alternates: FilmPickLike[] } | null;
    food: { dishes: { title: string }[] } | null;
    music: { before: { title: string }[]; after: { title: string }[] } | null;
  } | null;
}

export interface DemoOptions {
  log?: (line: string) => void;
  /** Collection name to use (case-insensitive); default: the first granted collection. */
  collectionName?: string;
  /** Instruction for the film replacement (treated as data by the service). */
  instruction?: string;
  pollIntervalMs?: number;
  jobTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Optional agent-side model that writes the replacement instruction from the current plan. */
  chooseInstruction?: (plan: { film: string; title: string | null }) => Promise<string>;
}

const DEFAULT_INSTRUCTION = 'Suggest a different film with the same mood.';

export interface DemoResult {
  collectionId: string;
  relatedJob: JobLike | null;
  planId: string;
  planJobId: string;
  replacementJobId: string;
  planBefore: PlanLike;
  planAfter: PlanLike;
  boundaryChecks: { check: string; outcome: string }[];
  calls: { tool: string; ok: boolean; summary: string }[];
}

export class DemoError extends Error {}

const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled']);
const PLAN_KIND_PRIORITY = ['film', 'artist', 'capture', 'track', 'food', 'style', 'brand', 'reference'];

function briefArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : JSON.stringify(v)}`)
    .join(', ');
}

function filmLine(plan: PlanLike): string {
  const f = plan.active_version?.film?.feature;
  return f ? `${f.title}${f.year ? ` (${f.year})` : ''}` : '(no film yet)';
}

export async function runDemo(caller: ToolCaller, options: DemoOptions = {}): Promise<DemoResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = options.pollIntervalMs ?? 1500;
  const timeoutMs = options.jobTimeoutMs ?? 90_000;
  const calls: DemoResult['calls'] = [];

  async function call<T>(tool: string, args: Record<string, unknown>, describe: (data: T) => string): Promise<ToolOutcome<T>> {
    log(`→ ${tool}(${briefArgs(args)})`);
    const out = await caller.callTool<T>(tool, args);
    const summary = out.ok ? describe(out.data) : `refused: ${out.error.code} — ${out.error.message}`;
    log(`  ← ${summary}`);
    calls.push({ tool, ok: out.ok, summary });
    return out;
  }

  async function must<T>(tool: string, args: Record<string, unknown>, describe: (data: T) => string): Promise<T> {
    const out = await call<T>(tool, args, describe);
    if (!out.ok) throw new DemoError(`${tool} failed: ${out.error.code}`);
    return out.data;
  }

  async function waitForJob(jobId: string): Promise<JobLike> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await must<JobLike>('get_job', { job_id: jobId }, (j) => `job ${j.state}${j.stage ? ` (${j.stage})` : ''}`);
      if (TERMINAL.has(job.state)) return job;
      if (Date.now() > deadline) throw new DemoError(`job ${jobId} did not finish in time`);
      await sleep(Math.max(50, Math.min(job.poll_after_ms ?? pollMs, pollMs)));
    }
  }

  log('culture atlas demo agent: connected over MCP; every line below is one service call.');

  // 1. Read the granted collection.
  const list = await must<{ collections: CollectionSummaryLike[]; unfiled: unknown }>('list_collections', {}, (d) =>
    `${d.collections.length} granted collection(s): ${d.collections.map((c) => `“${c.name}”`).join(', ') || 'none'}${d.unfiled === null ? '; unfiled saves not visible' : ''}`,
  );
  const wanted = options.collectionName?.toLowerCase();
  const chosen = list.collections.find((c) => (wanted ? c.name.toLowerCase() === wanted : c.item_count >= 2)) ?? list.collections[0];
  if (!chosen) throw new DemoError('This connection has no granted collections.');
  const detail = await must<CollectionDetailLike>('get_collection', { collection_id: chosen.id }, (d) =>
    `“${d.collection.name}” revision ${d.collection.revision}: ${d.items.map((m) => `${m.item.title} [${m.item.kind}]`).join(', ')}`,
  );
  const items = detail.items.map((m) => m.item);
  if (items.length < 2) throw new DemoError('The collection needs at least two items for a movie night.');

  // 2. Boundary checks: global taste must be refused for a selected-collection grant; collection taste works.
  const boundaryChecks: DemoResult['boundaryChecks'] = [];
  const globalTaste = await call<{ interests: unknown[] }>('get_taste', {}, (d) => `global taste visible (${d.interests.length} interests)`);
  boundaryChecks.push({ check: 'global taste', outcome: globalTaste.ok ? 'visible (whole-library connection)' : globalTaste.error.code });
  const scopedTaste = await call<{ interests: { label: string }[] }>('get_taste', { collection_id: chosen.id }, (d) =>
    `collection taste: ${d.interests.slice(0, 4).map((i) => i.label).join(', ') || 'no interests yet'}`,
  );
  boundaryChecks.push({ check: 'collection taste', outcome: scopedTaste.ok ? 'visible' : scopedTaste.error.code });

  // 3. Related discoveries for one granted item.
  const origin = items.find((i) => i.kind === 'artist') ?? items.find((i) => i.kind === 'film') ?? items[0]!;
  let relatedJob: JobLike | null = null;
  const related = await call<{ job_id: string; reused: boolean }>(
    'discover_related',
    { item_id: origin.id, collection_id: chosen.id },
    (d) => `started related discovery job ${d.job_id}${d.reused ? ' (reused)' : ''}`,
  );
  if (related.ok) relatedJob = await waitForJob(related.data.job_id);

  // 4. Movie night from 2-5 mixed items.
  const ranked = [...items].sort((a, b) => PLAN_KIND_PRIORITY.indexOf(a.kind) - PLAN_KIND_PRIORITY.indexOf(b.kind));
  let selection = ranked.slice(0, Math.min(3, ranked.length)).map((i) => i.id);
  let created = await call<{ plan_id: string; job_id: string }>(
    'create_plan',
    { collection_id: chosen.id, expected_revision: detail.collection.revision, item_ids: selection, template: 'movie_night', exploration: 'balanced' },
    (d) => `plan ${d.plan_id}, job ${d.job_id}`,
  );
  if (!created.ok && created.error.code === 'invalid_input') {
    // Some items may be too weak to anchor a plan; try the strongest-looking pair of other kinds.
    const others = ranked.filter((i) => i.kind !== 'capture').map((i) => i.id);
    if (others.length >= 2) {
      selection = others.slice(0, 2);
      created = await call<{ plan_id: string; job_id: string }>(
        'create_plan',
        { collection_id: chosen.id, expected_revision: detail.collection.revision, item_ids: selection, template: 'movie_night', exploration: 'balanced' },
        (d) => `plan ${d.plan_id}, job ${d.job_id}`,
      );
    }
  }
  if (!created.ok) throw new DemoError(`create_plan failed: ${created.error.code}`);
  await waitForJob(created.data.job_id);
  const planBefore = await must<PlanLike>('get_plan', { plan_id: created.data.plan_id }, (p) => `plan ${p.status}; film: ${filmLine(p)}`);

  // 5. Replace only the film section.
  let instruction = options.instruction ?? DEFAULT_INSTRUCTION;
  if (!options.instruction && options.chooseInstruction) {
    try {
      instruction = (await options.chooseInstruction({ film: filmLine(planBefore), title: planBefore.active_version?.title ?? null })).slice(0, 280) || DEFAULT_INSTRUCTION;
      log(`  (agent model chose the instruction: “${instruction}”)`);
    } catch (err) {
      log(`  (agent model unavailable: ${(err as Error).message}; using the default instruction)`);
    }
  }
  const replacement = await must<{ job_id: string }>(
    'replace_plan_section',
    { plan_id: created.data.plan_id, section: 'film', instruction },
    (d) => `replacement job ${d.job_id}`,
  );
  await waitForJob(replacement.job_id);
  const planAfter = await must<PlanLike>('get_plan', { plan_id: created.data.plan_id }, (p) => `plan ${p.status} v${p.active_version?.version ?? '?'}; film: ${filmLine(p)}`);

  log('');
  log(`Film before: ${filmLine(planBefore)}`);
  log(`Film after:  ${filmLine(planAfter)}`);
  log(`Food and music kept: ${JSON.stringify(planAfter.active_version?.food) === JSON.stringify(planBefore.active_version?.food) && JSON.stringify(planAfter.active_version?.music) === JSON.stringify(planBefore.active_version?.music) ? 'yes' : 'changed'}`);
  for (const b of boundaryChecks) log(`Boundary — ${b.check}: ${b.outcome}`);

  return { collectionId: chosen.id, relatedJob, planId: created.data.plan_id, planJobId: created.data.job_id, replacementJobId: replacement.job_id, planBefore, planAfter, boundaryChecks, calls };
}
