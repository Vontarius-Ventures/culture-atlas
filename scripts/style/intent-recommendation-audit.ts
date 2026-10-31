/**
 * Offline intent funnels and private human review packets.
 * Input is an explicit cached projection, not inferred catalogue-wide recall.
 * Never fetches, contacts a provider, changes admission, or writes on import.
 */
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonicalImage,
  cliError,
  digest,
  enumValue,
  fail,
  integer,
  privateDirectory,
  readBytes,
  readJson,
  record,
  sha256,
  token,
  writeExclusive,
} from './private-artifacts';

const INTENTS = ['visual', 'connections'] as const;
const LABELS = ['left', 'right', 'tie', 'neither', 'unknown', 'not_evaluated'] as const;
const DIMENSIONS = ['visual_alternative', 'subject_understanding', 'cultural_connection'] as const;
const LIMITS = {
  captures: 256,
  candidates: 512,
  totalCandidates: 10000,
  pairs: 4096,
  assetBytes: 8 * 1024 * 1024,
  totalAssetBytes: 128 * 1024 * 1024,
};
type Intent = (typeof INTENTS)[number];
type Label = (typeof LABELS)[number];
type Asset = { path: string; sha256: string; provenance: string };
type Candidate = {
  ref: string;
  subject: string;
  admission: string;
  strength: string;
  display: string;
  url: boolean | null;
  asset?: Asset;
  context?: { title: string; explanation: string; relation: string; subject_label: string };
};
type Pool = { retrieval: string; completeness: string; candidates: Candidate[] };
type Pair = { ref: string; intent: Intent; left: string; right: string };
type Capture = {
  ref: string;
  source: string;
  guard: string;
  asset?: Asset;
  intents: Record<Intent, Pool>;
  pairs: Pair[];
};
type Verified = {
  status: string;
  declared?: Asset;
  hash?: string;
  canonicalHash?: string;
  bytes?: Buffer;
};
const array = (x: unknown, max: number): unknown[] =>
  Array.isArray(x) && x.length <= max ? x : fail('invalid_array');
const asset = (x: unknown): Asset | undefined => {
  if (x === undefined || x === null) return undefined;
  const a = record(x);
  if (
    typeof a.path !== 'string' ||
    a.path.length > 4096 ||
    !isAbsolute(a.path) ||
    resolve(a.path) !== a.path
  )
    fail('invalid_asset_path');
  return { path: a.path, sha256: digest(a.sha256), provenance: token(a.provenance) };
};
const counts = (values: string[]) => {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
};
function reviewContext(value: unknown): Candidate['context'] {
  if (value === undefined) return undefined;
  const c = record(value);
  const field = (key: string, max: number) => {
    const v = c[key];
    if (typeof v !== 'string' || v.length > max) fail('invalid_review_context');
    return v;
  };
  // Deliberately private, bounded card/subject context, not entire provider responses.
  return {
    title: field('title', 300),
    explanation: field('explanation', 2000),
    relation: field('relation', 100),
    subject_label: field('subject_label', 300),
  };
}
export function parseCachedInput(input: unknown): Capture[] {
  const root = record(input);
  if (root.schema_version !== 'atlas_intent_cached_input_v1') fail('invalid_schema');
  const expected = integer(root.expected_capture_count, 1, LIMITS.captures);
  const rows = array(root.captures, LIMITS.captures);
  if (!rows.length || rows.length !== expected) fail('capture_denominator_mismatch');
  const refs = new Set<string>();
  let totalCandidates = 0,
    totalPairs = 0;
  return rows.map((value) => {
    const c = record(value),
      source = record(c.source),
      intents = record(c.intents);
    const ref = token(c.ref);
    if (!/^c\d{4}$/.test(ref) || refs.has(ref)) fail('duplicate_or_invalid_capture');
    integer(Number(ref.slice(1)), 1, expected);
    refs.add(ref);
    const pools = {} as Record<Intent, Pool>;
    for (const intent of INTENTS) {
      const pool = record(intents[intent]);
      const seen = new Set<string>();
      const candidates = array(pool.candidates, LIMITS.candidates).map((value): Candidate => {
        const row = record(value),
          ref = token(row.ref);
        if (!/^r\d{4}$/.test(ref) || seen.has(ref)) fail('duplicate_or_invalid_candidate');
        seen.add(ref);
        if (row.image_url_present !== null && typeof row.image_url_present !== 'boolean')
          fail('invalid_url_presence');
        const subject = enumValue(row.subject_id, ['s1', 's2', 'unknown'] as const);
        return {
          ref,
          subject,
          admission: enumValue(row.admission, [
            'admitted',
            'rejected',
            'pending',
            'unknown',
          ] as const),
          strength: enumValue(row.strength, [
            'strong',
            'moderate',
            'weak',
            'none',
            'unknown',
          ] as const),
          display: enumValue(row.display, ['shown', 'hidden', 'unknown'] as const),
          url: row.image_url_present,
          asset: asset(row.image_asset),
          context: reviewContext(row.review_context),
        };
      });
      totalCandidates += candidates.length;
      if (totalCandidates > LIMITS.totalCandidates) fail('input_limit_exceeded');
      pools[intent] = {
        retrieval: enumValue(pool.retrieval, [
          'complete',
          'partial',
          'empty',
          'error',
          'unavailable',
          'pending',
          'unknown',
        ] as const),
        completeness: enumValue(pool.pool_completeness, [
          'complete',
          'partial',
          'unknown',
        ] as const),
        candidates,
      };
      if (
        (pools[intent].retrieval === 'empty' && candidates.length) ||
        (pools[intent].completeness === 'complete' &&
          ['partial', 'error', 'unavailable', 'pending', 'unknown'].includes(
            pools[intent].retrieval,
          ))
      )
        fail('contradictory_pool_evidence');
    }
    const pairRefs = new Set<string>(),
      keys = new Set<string>();
    const pairs = array(c.review_pairs ?? [], LIMITS.pairs).map((value): Pair => {
      const p = record(value),
        ref = token(p.ref);
      const intent = enumValue(p.intent, INTENTS),
        left = token(p.left),
        right = token(p.right);
      const key = `${intent}:${[left, right].sort().join('|')}`;
      if (!/^p\d{4}$/.test(ref) || left === right || pairRefs.has(ref) || keys.has(key))
        fail('duplicate_or_invalid_pair');
      const pool = pools[intent].candidates;
      if (!pool.some((x) => x.ref === left) || !pool.some((x) => x.ref === right))
        fail('unknown_pair_candidate');
      pairRefs.add(ref);
      keys.add(key);
      return { ref, intent, left, right };
    });
    totalPairs += pairs.length;
    if (totalPairs > LIMITS.pairs) fail('input_limit_exceeded');
    return {
      ref,
      source: enumValue(source.state, ['available', 'missing', 'error', 'unknown'] as const),
      guard: enumValue(source.guard, ['passed', 'held', 'failed', 'unknown'] as const),
      asset: asset(source.image_asset),
      intents: pools,
      pairs,
    };
  });
}

export async function auditIntentInput(
  input: unknown,
  options: { judgments?: unknown; packetDirectory?: string } = {},
) {
  const captures = parseCachedInput(input);
  const provenanceInput = record(record(input).provenance ?? {});
  const declaredHash = (value: unknown) =>
    value === undefined || value === 'unknown' ? 'unknown' : digest(value);
  const provenance = {
    capture_set_sha256: declaredHash(provenanceInput.capture_set_sha256),
    catalog_sha256: declaredHash(provenanceInput.catalog_sha256),
    comparison_profile:
      provenanceInput.comparison_profile === undefined
        ? 'unknown'
        : token(provenanceInput.comparison_profile),
  };
  const inputHash = sha256(Buffer.from(JSON.stringify({ captures, provenance })));
  const verified = new Map<string, Verified>();
  let totalBytes = 0,
    totalCanonicalBytes = 0;
  async function verify(a?: Asset): Promise<Verified> {
    if (!a) return { status: 'not_recorded' };
    const key = `${a.path}:${a.sha256}`;
    const prior = verified.get(key);
    if (prior) return prior;
    let result: Verified;
    try {
      const bytes = await readBytes(a.path, LIMITS.assetBytes);
      totalBytes += bytes.length;
      if (totalBytes > LIMITS.totalAssetBytes) fail('total_asset_limit_exceeded');
      const hash = sha256(bytes);
      if (hash !== a.sha256) result = { status: 'hash_mismatch', declared: a };
      else {
        try {
          const image = await canonicalImage(bytes);
          totalCanonicalBytes += image.bytes.length;
          if (totalCanonicalBytes > LIMITS.totalAssetBytes) fail('total_asset_limit_exceeded');
          result = {
            status: 'verified',
            declared: a,
            hash,
            canonicalHash: image.hash,
            ...(options.packetDirectory ? { bytes: image.bytes } : {}),
          };
        } catch (error) {
          if (cliError(error) === 'total_asset_limit_exceeded') throw error;
          result = { status: 'invalid_image', declared: a };
        }
      }
    } catch (error) {
      if (cliError(error) === 'total_asset_limit_exceeded') throw error;
      result = {
        status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
        declared: a,
      };
    }
    verified.set(key, result);
    return result;
  }
  const captureAssets = new Map<string, Verified>();
  const candidateAssets = new Map<string, Verified>();
  for (const c of captures) {
    captureAssets.set(c.ref, await verify(c.asset));
    for (const intent of INTENTS)
      for (const row of c.intents[intent].candidates)
        candidateAssets.set(`${c.ref}:${intent}:${row.ref}`, await verify(row.asset));
  }
  const judgments = new Map<string, Record<(typeof DIMENSIONS)[number], Label>>();
  if (options.judgments !== undefined) {
    const root = record(options.judgments);
    if (root.schema_version !== 'atlas_intent_human_judgments_v1') fail('invalid_judgment_schema');
    for (const value of array(root.judgments, LIMITS.pairs)) {
      const row = record(value),
        capture = token(row.capture),
        pairRef = token(row.pair);
      const c = captures.find((x) => x.ref === capture),
        p = c?.pairs.find((x) => x.ref === pairRef);
      if (!c || !p) fail('unknown_judgment_pair');
      const key = `${capture}:${pairRef}`;
      if (judgments.has(key)) fail('duplicate_judgment');
      const labels = record(row.labels);
      const projected = Object.fromEntries(
        DIMENSIONS.map((d) => [d, enumValue(labels[d], LABELS)]),
      ) as Record<(typeof DIMENSIONS)[number], Label>;
      if (DIMENSIONS.some((d) => !['unknown', 'not_evaluated'].includes(projected[d]))) {
        token(row.reviewer);
        const s = captureAssets.get(capture)!;
        const l = candidateAssets.get(`${capture}:${p.intent}:${p.left}`)!;
        const r = candidateAssets.get(`${capture}:${p.intent}:${p.right}`)!;
        if (
          [s, l, r].some((a) => a.status !== 'verified') ||
          c.source !== 'available' ||
          c.guard !== 'passed'
        )
          fail('judgment_images_not_evaluable');
        const binding = record(row.asset_hashes);
        if (binding.source !== s.hash || binding.left !== l.hash || binding.right !== r.hash)
          fail('judgment_asset_binding_mismatch');
      }
      if (DIMENSIONS.some((d) => projected[d] !== 'not_evaluated')) {
        if (token(row.reviewer) === 'not_evaluated') fail('human_reviewer_required');
        if (root.input_sha256 !== inputHash) fail('judgment_input_binding_mismatch');
      }
      judgments.set(key, projected);
    }
  }
  const reports = captures.map((c) => ({
    ref: c.ref,
    source: c.source,
    guard: c.guard,
    source_image: captureAssets.get(c.ref)!.status,
    intents: Object.fromEntries(
      INTENTS.map((intent) => {
        const p = c.intents[intent];
        const rows = p.candidates.map((row) => {
          const image = candidateAssets.get(`${c.ref}:${intent}:${row.ref}`)!;
          return {
            // Surrogate references only: no provider/catalog IDs, names, paths, URLs or error text.
            ref: row.ref,
            subject_id: row.subject,
            admission: row.admission,
            strength: row.strength,
            display: row.display,
            image_url_present: row.url,
            cached_image: image.status,
            pairwise_evaluable:
              image.status === 'verified' &&
              captureAssets.get(c.ref)!.status === 'verified' &&
              c.source === 'available' &&
              c.guard === 'passed',
          };
        });
        return [
          intent,
          {
            retrieval: p.retrieval,
            pool_completeness: p.completeness,
            catalog_recall: 'unknown',
            observed_candidates: rows.length,
            total_pool_candidates: p.completeness === 'complete' ? rows.length : null,
            admission: counts(rows.map((r) => r.admission)),
            strength: counts(rows.map((r) => r.strength)),
            display: counts(rows.map((r) => r.display)),
            cached_image: counts(rows.map((r) => r.cached_image)),
            source_guard_display_conflicts:
              c.guard === 'passed' ? 0 : rows.filter((r) => r.display === 'shown').length,
            rejected_display_conflicts: rows.filter(
              (r) => r.admission === 'rejected' && r.display === 'shown',
            ).length,
            candidates: rows,
          },
        ];
      }),
    ),
    pairs: c.pairs.map((p) => ({
      ref: p.ref,
      intent: p.intent,
      labels:
        judgments.get(`${c.ref}:${p.ref}`) ??
        Object.fromEntries(DIMENSIONS.map((d) => [d, 'not_evaluated'])),
    })),
  }));
  const report = {
    schema_version: 'atlas_intent_audit_v1',
    input_sha256: inputHash,
    scope: 'cached_recording_only_not_catalog_recall',
    catalog_recall: 'unknown',
    automatic_candidate_promotion: false,
    capture_count: captures.length,
    provenance: Object.fromEntries(
      Object.entries(provenance).map(([key, value]) => [
        key,
        value === 'unknown' ? 'unknown' : 'declared',
      ]),
    ),
    human_evaluation: [...judgments.values()].some((labels) =>
      DIMENSIONS.some((d) => labels[d] !== 'not_evaluated'),
    )
      ? 'supplied_labels_only'
      : 'not_evaluated',
    summary: {
      source: counts(captures.map((c) => c.source)),
      guard: counts(captures.map((c) => c.guard)),
      intents: Object.fromEntries(
        INTENTS.map((intent) => {
          const pools = captures.map((c) => c.intents[intent]);
          const candidates = pools.flatMap((p) => p.candidates);
          const pairs = reports.flatMap((c) => c.pairs.filter((p) => p.intent === intent));
          const imageRows = captures.flatMap((c) =>
            c.intents[intent].candidates.map((row) => ({
              image: candidateAssets.get(`${c.ref}:${intent}:${row.ref}`)!.status,
              evaluable:
                c.source === 'available' &&
                c.guard === 'passed' &&
                captureAssets.get(c.ref)!.status === 'verified' &&
                candidateAssets.get(`${c.ref}:${intent}:${row.ref}`)!.status === 'verified',
            })),
          );
          return [
            intent,
            {
              captures: captures.length,
              retrieval: counts(pools.map((p) => p.retrieval)),
              pool_completeness: counts(pools.map((p) => p.completeness)),
              observed_candidates: candidates.length,
              catalog_recall: 'unknown',
              total_recorded_pool_candidates: pools.every((p) => p.completeness === 'complete')
                ? candidates.length
                : null,
              admission: counts(candidates.map((r) => r.admission)),
              strength: counts(candidates.map((r) => r.strength)),
              display: counts(candidates.map((r) => r.display)),
              cached_image: counts(imageRows.map((r) => r.image)),
              image_evaluable_candidates: imageRows.filter((r) => r.evaluable).length,
              human_pairwise_labels: Object.fromEntries(
                DIMENSIONS.map((d) => [d, counts(pairs.map((p) => p.labels[d]!))]),
              ),
            },
          ];
        }),
      ),
    },
    captures: reports,
  };
  if (options.packetDirectory) {
    const root = options.packetDirectory;
    await privateDirectory(root);
    const assetsDir = join(root, 'assets');
    await mkdir(assetsDir, { mode: 0o700 });
    const written = new Set<string>();
    for (const a of verified.values())
      if (a.status === 'verified' && a.canonicalHash && a.bytes && !written.has(a.canonicalHash)) {
        await writeExclusive(join(assetsDir, `${a.canonicalHash}.jpg`), a.bytes);
        written.add(a.canonicalHash);
      }
    const projection = (a: Verified) => ({
      status: a.status,
      ...(a.declared
        ? {
            original_path: a.declared.path,
            declared_sha256: a.declared.sha256,
            provenance: a.declared.provenance,
          }
        : {}),
      ...(a.status === 'verified'
        ? {
            original_sha256: a.hash,
            cached_path: join(assetsDir, `${a.canonicalHash}.jpg`),
            cached_sha256: a.canonicalHash,
          }
        : {}),
    });
    await writeExclusive(
      join(root, 'packet.json'),
      `${JSON.stringify({
        schema_version: 'atlas_intent_private_review_packet_v1',
        input_sha256: inputHash,
        provenance,
        instructions:
          'Human labels only. Compare named left/right images with source for each dimension. Unknown when evidence is insufficient; tie/neither permitted. Rejected candidates remain diagnostic-only. Do not publish this private file.',
        captures: captures.map((c) => ({
          ref: c.ref,
          source: projection(captureAssets.get(c.ref)!),
          candidates: INTENTS.flatMap((intent) =>
            c.intents[intent].candidates.map((r) => ({
              ref: r.ref,
              intent,
              subject_id: r.subject,
              admission: r.admission,
              strength: r.strength,
              display: r.display,
              review_context: r.context ?? null,
              asset: projection(candidateAssets.get(`${c.ref}:${intent}:${r.ref}`)!),
            })),
          ),
          pairs: c.pairs,
        })),
      })}\n`,
    );
    await writeExclusive(
      join(root, 'judgments-template.json'),
      `${JSON.stringify({
        schema_version: 'atlas_intent_human_judgments_v1',
        input_sha256: inputHash,
        judgments: captures.flatMap((c) =>
          c.pairs.map((p) => ({
            capture: c.ref,
            pair: p.ref,
            reviewer: 'not_evaluated',
            asset_hashes: {
              source: captureAssets.get(c.ref)?.hash ?? null,
              left: candidateAssets.get(`${c.ref}:${p.intent}:${p.left}`)?.hash ?? null,
              right: candidateAssets.get(`${c.ref}:${p.intent}:${p.right}`)?.hash ?? null,
            },
            labels: Object.fromEntries(DIMENSIONS.map((d) => [d, 'not_evaluated'])),
          })),
        ),
      })}\n`,
    );
    await writeExclusive(join(root, 'audit.json'), `${JSON.stringify(report)}\n`);
  }
  return report;
}
export async function main(args: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = enumValue(args[i], ['--input', '--out', '--packet', '--judgments'] as const),
      value = args[i + 1];
    if (!value || value.startsWith('--') || flags.has(key)) fail('invalid_arguments');
    flags.set(key, value);
  }
  if (!flags.get('--input')) fail('input_required');
  const input = await readJson(resolve(flags.get('--input')!));
  // The production frozen diagnostic must retain every one of the 24 photos.
  if (record(input).expected_capture_count !== 24) fail('frozen_24_capture_denominator_required');
  const report = await auditIntentInput(input, {
    judgments: flags.has('--judgments')
      ? await readJson(resolve(flags.get('--judgments')!))
      : undefined,
    packetDirectory: flags.get('--packet'),
  });
  const json = `${JSON.stringify(report)}\n`;
  if (flags.has('--out')) await writeExclusive(resolve(flags.get('--out')!), json);
  else process.stdout.write(json);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`Intent offline audit: ${cliError(e)}\n`);
    process.exitCode = 1;
  });
