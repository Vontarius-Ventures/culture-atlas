import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sha256Hex } from './labels';

/**
 * The text-role golden set as qualification uses it (quality plan §7.5, §8):
 * `<root>/manifest.json` pins every prompt and expect file by sha256, and
 * `--fixtures <root>/<role>` names one role's directory. Before any request,
 * the role directory must hold exactly the manifest's fixtures for that role,
 * every prompt and expect file must match its pinned hash, and the manifest's
 * own `golden_sha256` must be the digest of its file table. The artifact binds
 * that digest, so an artifact can only claim `text-v1` for the committed set.
 */
const TextGoldenManifest = z
  .object({
    golden_set: z.string().regex(/^text-v\d+$/),
    scorer_version: z.string().min(1),
    roles: z.record(z.string(), z.array(z.string().min(1))),
    files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    golden_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type TextGoldenManifest = z.infer<typeof TextGoldenManifest>;

export interface VerifiedTextGolden {
  goldenSet: string;
  goldenSha256: string;
  scorerVersion: string;
  /** Absolute paths of the role's prompt files, in manifest order. */
  fixtures: string[];
}

/** The digest build-text-fixtures.ts writes: sha256 of the file table sorted by path. */
export function textManifestDigest(files: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return sha256Hex(JSON.stringify(sorted));
}

export async function verifiedTextGolden(fixturesDir: string, role: string): Promise<VerifiedTextGolden> {
  const roleDir = path.resolve(fixturesDir);
  const root = path.dirname(roleDir);
  if (path.basename(roleDir) !== role)
    throw new Error(`Text fixtures for ${role} must be the golden set's ${role}/ directory; got ${path.basename(roleDir)}/.`);
  let raw: string;
  try {
    raw = await readFile(path.join(root, 'manifest.json'), 'utf8');
  } catch {
    throw new Error(`No text golden manifest at ${path.join(root, 'manifest.json')}; text roles qualify only on a pinned golden set.`);
  }
  const manifest = TextGoldenManifest.parse(JSON.parse(raw));
  if (textManifestDigest(manifest.files) !== manifest.golden_sha256)
    throw new Error('Text golden manifest: golden_sha256 does not match its file table.');
  const listed = manifest.roles[role];
  if (!listed?.length) throw new Error(`Text golden manifest lists no fixtures for ${role}.`);

  // Exactly the listed fixtures, nothing more and nothing less.
  const onDisk = (await readdir(roleDir)).filter((f) => f.endsWith('.json')).sort();
  const expected = new Set<string>();
  for (const rel of listed) {
    if (path.dirname(rel) !== role) throw new Error(`Text golden manifest: ${rel} is not under ${role}/.`);
    expected.add(path.basename(rel));
    expected.add(path.basename(rel).replace(/\.json$/, '.expect.json'));
  }
  const extra = onDisk.filter((f) => !expected.has(f));
  const missing = [...expected].filter((f) => !onDisk.includes(f));
  if (extra.length || missing.length)
    throw new Error(
      `Text fixtures for ${role} differ from the manifest${extra.length ? `; not listed: ${extra.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}.`,
    );

  const problems: string[] = [];
  for (const name of [...expected].sort()) {
    const rel = `${role}/${name}`;
    const pinned = manifest.files[rel];
    if (!pinned) {
      problems.push(`${rel}: not pinned`);
      continue;
    }
    if (sha256Hex(await readFile(path.join(roleDir, name))) !== pinned) problems.push(`${rel}: sha256 differs from the manifest`);
  }
  if (problems.length) throw new Error(`Text golden set check failed: ${problems.join('; ')}.`);
  return {
    goldenSet: manifest.golden_set,
    goldenSha256: manifest.golden_sha256,
    scorerVersion: manifest.scorer_version,
    fixtures: listed.map((rel) => path.join(root, rel)),
  };
}
