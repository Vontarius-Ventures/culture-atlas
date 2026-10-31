import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { auditIntentInput, main, parseCachedInput } from './intent-recommendation-audit';
import { sha256 } from './private-artifacts';

const roots: string[] = [];
async function temp() {
  const root = await realpath(await mkdtemp('/tmp/atlas-intent-synthetic-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const candidate = (ref = 'r0001', extra = {}) => ({
  ref,
  subject_id: 's1',
  admission: 'rejected',
  strength: 'weak',
  display: 'hidden',
  image_url_present: true,
  ...extra,
});
const pool = (candidates: unknown[] = [], extra = {}) => ({
  retrieval: 'partial',
  pool_completeness: 'unknown',
  candidates,
  ...extra,
});
const capture = (ref = 'c0001', extra = {}) => ({
  ref,
  source: { state: 'available', guard: 'passed' },
  intents: {
    visual: pool([candidate(), candidate('r0002')]),
    connections: pool([], { retrieval: 'error' }),
  },
  review_pairs: [{ ref: 'p0001', intent: 'visual', left: 'r0001', right: 'r0002' }],
  ...extra,
});
const input = (captures = [capture()]) => ({
  schema_version: 'atlas_intent_cached_input_v1',
  expected_capture_count: captures.length,
  captures,
});
const labels = (extra = {}) => ({
  visual_alternative: 'not_evaluated',
  subject_understanding: 'not_evaluated',
  cultural_connection: 'not_evaluated',
  ...extra,
});
const judgment = (extra = {}) => ({ capture: 'c0001', pair: 'p0001', labels: labels(), ...extra });
const judgments = (rows: unknown[]) => ({
  schema_version: 'atlas_intent_human_judgments_v1',
  judgments: rows,
});
async function syntheticAsset() {
  const root = await temp();
  const sharp = createRequire(new URL('../../packages/domain/package.json', import.meta.url))(
    'sharp',
  ) as (input: {
    create: { width: number; height: number; channels: number; background: string };
  }) => { png(): { toBuffer(): Promise<Buffer> } };
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const path = join(root, 'synthetic.png');
  await writeFile(path, bytes);
  return {
    root,
    bytes,
    asset: { path, sha256: sha256(bytes), provenance: 'synthetic_fixture_not_live_evidence' },
  };
}

describe('offline per-intent diagnostics and explicit human review', () => {
  it('retains all 24, including failures, empty and unknown pools without catalogue recall', async () => {
    const captures = Array.from({ length: 24 }, (_, i) =>
      capture(
        `c${String(i + 1).padStart(4, '0')}`,
        i === 0
          ? {
              source: { state: 'error', guard: 'failed' },
              intents: {
                visual: pool([], { retrieval: 'empty', pool_completeness: 'complete' }),
                connections: pool([], { retrieval: 'unavailable' }),
              },
              review_pairs: [],
            }
          : {},
      ),
    );
    const report = await auditIntentInput(input(captures));
    expect(report.capture_count).toBe(24);
    expect(report.catalog_recall).toBe('unknown');
    expect(report.captures[0]).toMatchObject({ source: 'error', guard: 'failed' });
    expect(report.captures[0]!.intents.visual).toMatchObject({
      retrieval: 'empty',
      observed_candidates: 0,
      total_pool_candidates: 0,
      catalog_recall: 'unknown',
    });
    expect(report.captures[1]!.intents.visual).toMatchObject({
      total_pool_candidates: null,
      pool_completeness: 'unknown',
    });
    expect(report.captures[1]!.intents.connections).toMatchObject({ retrieval: 'error' });
    expect(report.human_evaluation).toBe('not_evaluated');
    expect(report.captures[1]!.pairs[0]!.labels).toEqual(labels());
  });
  it('does not treat image URLs as cached or evaluable image evidence', async () => {
    const report = await auditIntentInput(input());
    const rows = report.captures[0]!.intents.visual!.candidates;
    expect(rows[0]).toMatchObject({
      image_url_present: true,
      cached_image: 'not_recorded',
      pairwise_evaluable: false,
      admission: 'rejected',
    });
    expect(report.automatic_candidate_promotion).toBe(false);
  });
  it('retains missing/hash-mismatched/invalid images and rejects symlink evidence', async () => {
    const { root, asset } = await syntheticAsset();
    await writeFile(join(root, 'invalid'), 'not an image');
    await symlink(asset.path, join(root, 'link'));
    const candidates = [
      candidate('r0001', { image_asset: { ...asset, path: join(root, 'missing') } }),
      candidate('r0002', { image_asset: { ...asset, sha256: '0'.repeat(64) } }),
      candidate('r0003', {
        image_asset: {
          ...asset,
          path: join(root, 'invalid'),
          sha256: sha256(Buffer.from('not an image')),
        },
      }),
      candidate('r0004', { image_asset: { ...asset, path: join(root, 'link') } }),
    ];
    const report = await auditIntentInput(
      input([capture('c0001', { intents: { visual: pool(candidates), connections: pool() } })]),
    );
    expect(report.captures[0]!.intents.visual!.cached_image).toEqual({
      missing: 1,
      hash_mismatch: 1,
      invalid_image: 1,
      unreadable: 1,
    });
  });
  it('creates private canonical packet with explicit provenance/hashes and no invented labels', async () => {
    const { root, asset } = await syntheticAsset();
    const c = capture('c0001', {
      source: { state: 'available', guard: 'passed', image_asset: asset },
      intents: {
        visual: pool([
          candidate('r0001', { image_asset: asset }),
          candidate('r0002', { image_asset: asset }),
        ]),
        connections: pool(),
      },
    });
    const packet = join(root, 'packet');
    const report = await auditIntentInput(input([c]), { packetDirectory: packet });
    expect(report.captures[0]!.intents.visual!.candidates[0]!.pairwise_evaluable).toBe(true);
    const privatePacket = JSON.parse(await readFile(join(packet, 'packet.json'), 'utf8')) as {
      captures: {
        source: {
          original_path: string;
          original_sha256: string;
          cached_path: string;
          cached_sha256: string;
          provenance: string;
        };
      }[];
    };
    const source = privatePacket.captures[0]!.source;
    expect(source.original_path).toBe(asset.path);
    expect(source.original_sha256).toBe(asset.sha256);
    expect(source.provenance).toBe(asset.provenance);
    expect(sha256(await readFile(source.cached_path))).toBe(source.cached_sha256);
    const template = JSON.parse(
      await readFile(join(packet, 'judgments-template.json'), 'utf8'),
    ) as { judgments: { labels: unknown }[] };
    expect(template.judgments[0]!.labels).toEqual(labels());
    expect((await stat(packet)).mode & 0o777).toBe(0o700);
    expect((await stat(join(packet, 'packet.json'))).mode & 0o777).toBe(0o600);
    await expect(auditIntentInput(input([c]), { packetDirectory: packet })).rejects.toThrow();
    const boundJudgment = judgment({
      reviewer: 'human_operator',
      asset_hashes: { source: asset.sha256, left: asset.sha256, right: asset.sha256 },
      labels: labels({
        visual_alternative: 'tie',
        subject_understanding: 'neither',
        cultural_connection: 'unknown',
      }),
    });
    const evaluated = await auditIntentInput(input([c]), {
      judgments: { ...judgments([boundJudgment]), input_sha256: report.input_sha256 },
    });
    expect(evaluated.captures[0]!.pairs[0]!.labels).toEqual(boundJudgment.labels);
    expect(evaluated.captures[0]!.intents.visual!.candidates[0]!.admission).toBe('rejected');
    await expect(
      auditIntentInput(input([c]), { judgments: judgments([boundJudgment]) }),
    ).rejects.toThrow('judgment_input_binding_mismatch');
    await expect(
      auditIntentInput(input([c]), {
        judgments: judgments([{ ...boundJudgment, asset_hashes: { source: '0'.repeat(64) } }]),
      }),
    ).rejects.toThrow('judgment_asset_binding_mismatch');
  });
  it('requires actual image evidence and guard for human preferences, not URL presence', async () => {
    await expect(
      auditIntentInput(input(), {
        judgments: judgments([
          judgment({ reviewer: 'human', labels: labels({ visual_alternative: 'left' }) }),
        ]),
      }),
    ).rejects.toThrow('judgment_images_not_evaluable');
  });
  it('rejects duplicate labels, reversed duplicate pairs, unknown pairs and invalid labels', async () => {
    await expect(
      auditIntentInput(input(), { judgments: judgments([judgment(), judgment()]) }),
    ).rejects.toThrow('duplicate_judgment');
    await expect(
      auditIntentInput(input(), { judgments: judgments([judgment({ pair: 'p9999' })]) }),
    ).rejects.toThrow('unknown_judgment_pair');
    await expect(
      auditIntentInput(input(), {
        judgments: judgments([judgment({ labels: labels({ visual_alternative: 'invented' }) })]),
      }),
    ).rejects.toThrow('invalid_enum');
    expect(() =>
      parseCachedInput(
        input([
          capture('c0001', {
            review_pairs: [
              { ref: 'p0001', intent: 'visual', left: 'r0001', right: 'r0002' },
              { ref: 'p0002', intent: 'visual', left: 'r0002', right: 'r0001' },
            ],
          }),
        ]),
      ),
    ).toThrow('duplicate_or_invalid_pair');
  });
  it('projects no URLs, paths, raw errors, cookie/session payloads or candidate identities', async () => {
    const privateText = 'https://private.example/photo?session=SUPERSECRET';
    const c = capture('c0001', {
      name: privateText,
      raw_response: privateText,
      cookie: privateText,
      error: privateText,
      intents: {
        visual: pool([
          candidate('r0001', {
            review_context: {
              title: privateText,
              explanation: privateText,
              relation: 'synthetic',
              subject_label: privateText,
            },
          }),
          candidate('r0002'),
        ]),
        connections: pool(),
      },
    });
    const report = JSON.stringify(
      await auditIntentInput({ ...input([c]), session_response: privateText }),
    );
    expect(report).not.toContain('SUPERSECRET');
    expect(report).not.toContain('https:');
    expect(report).not.toContain('raw_response');
    expect(() =>
      parseCachedInput(
        input([
          capture('c0001', {
            intents: { visual: pool([candidate('SECRET')]), connections: pool() },
            review_pairs: [],
          }),
        ]),
      ),
    ).toThrow('duplicate_or_invalid_candidate');
  });
  it('keeps completeness unknown even when provider retrieval declares complete', async () => {
    const report = await auditIntentInput(
      input([
        capture('c0001', {
          intents: { visual: pool([], { retrieval: 'complete' }), connections: pool() },
          review_pairs: [],
        }),
      ]),
    );
    expect(report.captures[0]!.intents.visual!.total_pool_candidates).toBeNull();
    expect(report.catalog_recall).toBe('unknown');
  });
  it('keeps all-default supplied templates not evaluated, and explicitly supplied unknown distinct', async () => {
    const initial = await auditIntentInput(input());
    const template = await auditIntentInput(input(), { judgments: judgments([judgment()]) });
    expect(template.human_evaluation).toBe('not_evaluated');
    const unknown = {
      ...judgments([
        judgment({ reviewer: 'human', labels: labels({ visual_alternative: 'unknown' }) }),
      ]),
      input_sha256: initial.input_sha256,
    };
    const reviewed = await auditIntentInput(input(), { judgments: unknown });
    expect(reviewed.captures[0]!.pairs[0]!.labels.visual_alternative).toBe('unknown');
    expect(reviewed.provenance).toEqual({
      capture_set_sha256: 'unknown',
      catalog_sha256: 'unknown',
      comparison_profile: 'unknown',
    });
    await expect(
      auditIntentInput(input(), { judgments: { ...unknown, input_sha256: '0'.repeat(64) } }),
    ).rejects.toThrow('judgment_input_binding_mismatch');
  });
  it('rejects invalid denominators, fields, contradictory complete pools and duplicates', () => {
    expect(() => parseCachedInput({ ...input(), expected_capture_count: 24 })).toThrow(
      'capture_denominator_mismatch',
    );
    expect(() => parseCachedInput(input([capture(), capture()]))).toThrow(
      'duplicate_or_invalid_capture',
    );
    expect(() =>
      parseCachedInput(
        input([
          capture('c0001', {
            intents: { visual: pool([], { pool_completeness: 'complete' }), connections: pool() },
            review_pairs: [],
          }),
        ]),
      ),
    ).toThrow('contradictory_pool_evidence');
    expect(() => parseCachedInput({ schema_version: 'bad' })).toThrow('invalid_schema');
  });
  it('CLI requires the 24-photo denominator and never fetches', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const root = await temp(),
      path = join(root, 'input.json');
    await writeFile(path, JSON.stringify(input()));
    await expect(main(['--input', path])).rejects.toThrow('frozen_24_capture_denominator_required');
    await expect(main(['--fetch', 'yes'])).rejects.toThrow('invalid_enum');
    expect(fetch).not.toHaveBeenCalled();
  });
});
