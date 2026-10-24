/**
 * Live style smoke (PAID: real Concentrate and Qloo calls through a running
 * local stack). Uploads each photo as a new capture on a fresh local test
 * account, polls GET /v1/captures/{id} every 1.5 s like the clients do, and
 * records when each B.3 milestone became readable through the API:
 *   chips (observations complete), style ready, first More-like-this card,
 *   cross-domain cards, complete (job finished).
 * Also prints the style reading, the rails and every card reason, and checks
 * reason faithfulness (M-R3: every attribute a reason names is in the
 * published reading).
 *
 * Usage: tsx scripts/style/live-check.ts --confirm-paid-requests --base http://localhost:3901 --out <dir> [--city "Los Angeles, CA"] photo1.jpg [photo2.jpg ...]
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

interface Json {
  [k: string]: unknown;
}

const args = process.argv.slice(2);
if (!args.includes('--confirm-paid-requests')) {
  console.error('Refusing: this check sends paid model and Qloo requests. Re-run with --confirm-paid-requests.');
  process.exit(2);
}
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (flag('--base') ?? 'http://localhost:3901').replace(/\/+$/, '');
const out = flag('--out') ?? '.';
const city = flag('--city');
/**
 * --v2: upload through /v2 (media worker stage 1 + compile job), the path native apps use. /v2 needs a
 * verified email; on a LOCAL stack only, --local-db <url> records the fresh test account's address as
 * verified in that local database instead of running the mailbox flow.
 */
const v2 = args.includes('--v2');
const localDb = flag('--local-db');
const photos = args.filter((a, i) => !a.startsWith('--') && !['--base', '--out', '--city', '--local-db'].includes(args[i - 1] ?? ''));
mkdirSync(out, { recursive: true });

let cookie = '';
let csrf = '';
let accountId = '';
async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: Json | null }> {
  const headers: Record<string, string> = { cookie, ...extra };
  if (method !== 'GET') {
    headers['idempotency-key'] = randomUUID();
    headers['x-csrf-token'] = csrf;
    if (path.startsWith('/v2/') && accountId) headers['x-atlas-expected-account'] = accountId;
  }
  let payload: FormData | string | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload, redirect: 'manual' });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const kv = c.split(';')[0]!;
    if (kv.startsWith('ca_session=')) cookie = kv;
  }
  const text = await res.text();
  let json: Json | null;
  try {
    json = text ? (JSON.parse(text) as Json) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** /v2 photo: upload, wait for preparation, ask for an analysis, return its capture id and the v2 analysis body. */
async function captureViaV2(file: string, t0: number, marks: Record<string, number>): Promise<{ captureId: string; analysis: Json | null; assetId: string; analysisId: string }> {
  const bytes = readFileSync(file);
  const created = await call('POST', '/v2/uploads', {
    client_capture_id: randomUUID(),
    kind: 'photo',
    source: 'upload',
    filename: basename(file),
    content_type: 'image/jpeg',
    byte_size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  if (created.status !== 201) throw new Error(`v2 upload: ${created.status} ${JSON.stringify(created.json)}`);
  const { upload_id: uploadId, asset_id: assetId, part_size: partSize, part_count: count } = created.json as { upload_id: string; asset_id: string; part_size: number; part_count: number };
  const parts = await call('POST', `/v2/uploads/${uploadId}/parts`, { part_numbers: Array.from({ length: count }, (_, i) => i + 1) });
  const receipts: { part_number: number; etag: string }[] = [];
  for (const p of (parts.json!.parts as { part_number: number; url: string; headers: Record<string, string> }[])) {
    const url = p.url.startsWith('http') ? p.url : `${base}${p.url}`;
    const put = await fetch(url, { method: 'PUT', headers: { ...p.headers, cookie }, body: bytes.subarray((p.part_number - 1) * partSize, p.part_number * partSize) });
    if (put.status !== 200) throw new Error(`v2 part: ${put.status}`);
    receipts.push({ part_number: p.part_number, etag: put.headers.get('etag')! });
  }
  const done = await call('POST', `/v2/uploads/${uploadId}/complete`, { parts: receipts });
  if (done.status >= 300) throw new Error(`v2 complete: ${done.status} ${JSON.stringify(done.json)}`);
  marks.uploaded = Date.now() - t0;
  let generation = 0;
  for (let i = 0; i < 120; i++) {
    const media = await call('GET', `/v2/media/${assetId}`);
    const m = (media.json?.media ?? media.json) as Json;
    if (m?.status === 'ready') {
      generation = Number(m.generation ?? 1);
      break;
    }
    await sleep(500);
  }
  marks.prepared = Date.now() - t0;
  const asked = await call('POST', `/v2/media/${assetId}/analysis`, { mode: 'photo', expected_generation: generation });
  if (asked.status >= 300) throw new Error(`v2 analysis: ${asked.status} ${JSON.stringify(asked.json)}`);
  const analysisId = String(asked.json!.analysis_id);
  for (let i = 0; i < 120; i++) {
    const got = await call('GET', `/v2/media/${assetId}/analysis/${analysisId}`);
    if (got.json?.capture_id) {
      marks.chips = Date.now() - t0;
      return { captureId: String(got.json.capture_id), analysis: got.json, assetId, analysisId };
    }
    if (got.json?.state === 'failed') throw new Error(`v2 analysis failed: ${JSON.stringify(got.json)}`);
    await sleep(500);
  }
  throw new Error('v2 analysis did not publish');
}

async function main(): Promise<void> {
  const session = await call('GET', '/v1/session');
  csrf = String(session.json?.csrf_token ?? '');
  const email = `style-live-${Date.now()}@example.test`;
  const created = await call('POST', '/v1/accounts', { display_name: 'Style live check', email, password: `pw-${randomUUID()}`, claim_session: true });
  if (created.status !== 201) throw new Error(`account: ${created.status} ${JSON.stringify(created.json)}`);
  csrf = String(created.json?.csrf_token ?? csrf);
  const me = await call('GET', '/v1/session');
  accountId = String((me.json?.principal as Json | undefined)?.account_id ?? '');
  csrf = String(me.json?.csrf_token ?? csrf);
  if (v2) {
    const host = new URL(base).hostname;
    if (!localDb || !['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error('--v2 needs --local-db on a localhost stack');
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: localDb });
    await client.connect();
    await client.query('INSERT INTO account_emails (account_id, email, verified_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING', [accountId, email]);
    await client.end();
  }
  if (city) {
    const set = await call('PUT', '/v1/me/city', { city });
    if (set.status !== 204) throw new Error(`city: ${set.status} ${JSON.stringify(set.json)}`);
  }
  const report: Json[] = [];
  for (const file of photos) {
    const t0 = Date.now();
    const marks: Record<string, number> = {};
    let captureId: string;
    let uploadMs: number;
    let v2Ref: { assetId: string; analysisId: string } | null = null;
    if (v2) {
      const r = await captureViaV2(file, t0, marks);
      captureId = r.captureId;
      uploadMs = marks.uploaded ?? 0;
      v2Ref = { assetId: r.assetId, analysisId: r.analysisId };
    } else {
      const form = new FormData();
      form.set('image', new Blob([readFileSync(file)], { type: 'image/jpeg' }), basename(file));
      form.set('source', 'upload');
      const res = await call('POST', '/v1/captures', form);
      if (res.status !== 202) throw new Error(`capture ${file}: ${res.status} ${JSON.stringify(res.json)}`);
      uploadMs = Date.now() - t0;
      captureId = String(res.json!.capture_id);
    }
    let last: Json | null = null;
    const mark = (name: string) => {
      if (marks[name] === undefined) marks[name] = Date.now() - t0;
    };
    for (let i = 0; i < 80; i++) {
      await sleep(1500);
      const got = await call('GET', `/v1/captures/${captureId}`);
      last = got.json;
      const analysis = (last?.analysis ?? null) as Json | null;
      const sections = (analysis?.sections ?? {}) as Record<string, string>;
      if (sections.observations === 'complete') mark('chips');
      if (sections.style && ['ready', 'empty', 'failed', 'held'].includes(sections.style)) mark(`style_${sections.style}`);
      const rails = (last?.rails ?? []) as Json[];
      if (rails.some((r) => r.kind === 'more_like_this' && (r.cards as unknown[]).length > 0)) mark('first_more_like_this');
      if (rails.some((r) => r.kind === 'cross_domain' && (r.cards as unknown[]).length > 0)) mark('cross_domain_cards');
      if (last?.status === 'ready' || last?.status === 'partial' || last?.status === 'failed') {
        if (!last?.job_id) {
          mark('complete');
          break;
        }
      }
    }
    const reading = (last?.style_reading ?? null) as Json | null;
    const shown = new Set<string>();
    for (const s of ((reading?.subjects ?? []) as Json[]))
      for (const slot of ['aesthetics', 'materials', 'lineage', 'mood', 'construction'] as const)
        for (const c of (s[slot] ?? []) as Json[]) shown.add(String(c.name).toLowerCase());
    const cards: Json[] = [];
    let unfaithful = 0;
    for (const r of ((last?.rails ?? []) as Json[]))
      for (const c of (r.cards as Json[])) {
        const match = (c.style_match ?? null) as Json | null;
        const attrs = ((match?.attributes ?? []) as string[]).map((a) => a.toLowerCase());
        const bad = attrs.filter((a) => !shown.has(a));
        if (bad.length) unfaithful++;
        cards.push({ rail: r.key, title: c.title, reason: c.reason ?? null, attributes: match?.attributes ?? [] });
      }
    const v2Analysis = v2Ref ? (await call('GET', `/v2/media/${v2Ref.assetId}/analysis/${v2Ref.analysisId}`)).json : null;
    const entry = { photo: basename(file), path: v2 ? 'v2' : 'v1', v2_analysis: v2Analysis ? { experimental: v2Analysis.experimental ?? null, style: (v2Analysis.result as Json | null)?.style ?? null } : undefined, capture_id: captureId, upload_ms: uploadMs, milestones_ms: marks, experimental: (last?.analysis as Json | null)?.experimental ?? null, style_reading: reading, rails: ((last?.rails ?? []) as Json[]).map((r) => ({ key: r.key, status: r.status, subtitle: r.subtitle, empty_message: r.empty_message, caption: r.caption, cards: (r.cards as Json[]).length })), cards, reason_faithfulness_violations: unfaithful };
    report.push(entry);
    writeFileSync(join(out, `${basename(file)}.capture.json`), JSON.stringify(last, null, 2));
    console.log(JSON.stringify({ photo: entry.photo, path: entry.path, milestones_ms: marks, rails: entry.rails, violations: unfaithful, v2: entry.v2_analysis }, null, 0));
  }
  writeFileSync(join(out, 'live-check.json'), JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
