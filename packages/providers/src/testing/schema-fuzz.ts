import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { structuredOutputContract } from '../model-gateway/schema';

type JsonSchema = Record<string, unknown>;

/** Small deterministic PRNG (mulberry32) so failures are reproducible by seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/**
 * Random value conforming to the ORIGINAL zod JSON schema (constraints kept),
 * including absent optional keys. Used to show every zod-valid shape is
 * expressible through the strict provider schema.
 */
export function sampleFromJsonSchema(schema: JsonSchema, rand: () => number, depth = 0): unknown {
  const alternatives = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (alternatives)
    return sampleFromJsonSchema(alternatives[int(rand, 0, alternatives.length - 1)]!, rand, depth);
  if (schema.enum) {
    const values = schema.enum as unknown[];
    return values[int(rand, 0, values.length - 1)];
  }
  if (Object.hasOwn(schema, 'const')) return schema.const;
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const type = types[int(rand, 0, types.length - 1)];
  switch (type) {
    case 'null':
      return null;
    case 'boolean':
      return rand() < 0.5;
    case 'string': {
      const min = (schema.minLength as number | undefined) ?? 0;
      const max = Math.min((schema.maxLength as number | undefined) ?? min + 12, min + 12);
      const alphabet = 'abc xyz é"{}\\<>';
      return Array.from(
        { length: int(rand, min, max) },
        () => alphabet[int(rand, 0, alphabet.length - 1)],
      ).join('');
    }
    case 'integer':
    case 'number': {
      const min = (schema.minimum as number | undefined) ?? -1000;
      const max = (schema.maximum as number | undefined) ?? 1000;
      return type === 'integer'
        ? int(rand, Math.ceil(min), Math.floor(max))
        : min + rand() * (max - min);
    }
    case 'array': {
      const min = (schema.minItems as number | undefined) ?? 0;
      const max = Math.min((schema.maxItems as number | undefined) ?? 3, depth > 3 ? min : min + 3);
      return Array.from({ length: int(rand, min, max) }, () =>
        sampleFromJsonSchema(schema.items as JsonSchema, rand, depth + 1),
      );
    }
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set((schema.required as string[] | undefined) ?? []);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(properties)) {
        if (!required.has(key) && rand() < 0.4) continue;
        out[key] = sampleFromJsonSchema(child, rand, depth + 1);
      }
      return out;
    }
    default:
      throw new Error(`Unsupported JSON Schema node in fuzz generator: ${JSON.stringify(schema)}`);
  }
}

function objectNodes(
  value: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) value.forEach((child) => objectNodes(child, out));
  else if (value && typeof value === 'object') {
    out.push(value as Record<string, unknown>);
    Object.values(value).forEach((child) => objectNodes(child, out));
  }
  return out;
}

function dropNullKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNullKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, dropNullKeys(v)]),
  );
}

/**
 * Equal as JSON, where a key that zod declares `.nullable().optional()` may come
 * back as explicit null instead of absent (both mean "no value" to Atlas).
 */
function sameValue(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(dropNullKeys(a), dropNullKeys(b));
}

export interface EquivalenceReport {
  samples: number;
  roundTrips: number;
  rejectedMutations: number;
  failures: string[];
}

/**
 * Property check of structuredOutputContract(schema) against the zod schema:
 *  1. every generated zod-valid value encodes to a provider-schema-valid value
 *     and decodes back to a value zod accepts and that equals the original;
 *  2. adding an unknown key or deleting a required key anywhere is rejected by
 *     the strict decode, before zod could strip or default it.
 */
export function checkContractEquivalence(
  schema: z.ZodType,
  options: { samples?: number; seed?: number } = {},
): EquivalenceReport {
  const contract = structuredOutputContract(schema);
  const original = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'throw' }) as JsonSchema;
  const rand = seededRandom(options.seed ?? 1);
  const report: EquivalenceReport = {
    samples: 0,
    roundTrips: 0,
    rejectedMutations: 0,
    failures: [],
  };
  for (let i = 0; i < (options.samples ?? 200); i++) {
    const sample = sampleFromJsonSchema(original, rand);
    const parsed = schema.safeParse(sample);
    if (!parsed.success) {
      report.failures.push(`generator produced a zod-invalid sample #${i}`);
      continue;
    }
    report.samples++;
    const value = parsed.data;
    let encoded: unknown;
    try {
      encoded = contract.encode(JSON.parse(JSON.stringify(value)));
      // The encoded value must be accepted by the schema that is actually sent.
      structuredOutputContract(schema).decode(encoded);
    } catch (error) {
      report.failures.push(`sample #${i} not expressible: ${(error as Error).message}`);
      continue;
    }
    const decoded = contract.decode(JSON.parse(JSON.stringify(encoded)));
    const reparsed = schema.safeParse(decoded);
    if (!reparsed.success || !sameValue(reparsed.data, value)) {
      report.failures.push(`sample #${i} did not round-trip`);
      continue;
    }
    report.roundTrips++;
    const nodes = objectNodes(encoded);
    if (!nodes.length) continue;
    const target = nodes[int(rand, 0, nodes.length - 1)]!;
    const withExtra = JSON.parse(JSON.stringify(encoded));
    objectNodes(withExtra)[nodes.indexOf(target)]!['__untrusted_extra__'] = 'x';
    const keys = Object.keys(target);
    const missing = JSON.parse(JSON.stringify(encoded));
    if (keys.length)
      delete objectNodes(missing)[nodes.indexOf(target)]![keys[int(rand, 0, keys.length - 1)]!];
    for (const [label, mutated] of [
      ['extra key', withExtra],
      ...(keys.length ? [['missing key', missing] as const] : []),
    ] as const) {
      try {
        contract.decode(mutated);
        report.failures.push(`sample #${i}: ${label} accepted`);
      } catch {
        report.rejectedMutations++;
      }
    }
  }
  return report;
}
