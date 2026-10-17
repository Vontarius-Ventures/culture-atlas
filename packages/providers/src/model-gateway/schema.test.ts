import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RawExtraction } from '../research/wikipedia';
import { checkContractEquivalence } from '../testing/schema-fuzz';
import { VlmAnalysis } from '../vlm/types';
import {
  PROVIDER_SCHEMA_KEYWORDS,
  strictJsonSchema,
  structuredOutputContract,
  validateStrictShape,
} from './schema';

type Node = Record<string, unknown>;
function nodes(schema: Node, out: Node[] = []): Node[] {
  out.push(schema);
  for (const child of Object.values((schema.properties ?? {}) as Record<string, Node>))
    nodes(child, out);
  if (schema.items) nodes(schema.items as Node, out);
  for (const child of (schema.anyOf ?? []) as Node[]) nodes(child, out);
  for (const child of Object.values((schema.$defs ?? {}) as Record<string, Node>))
    nodes(child, out);
  return out;
}

describe('strict structured-output transform', () => {
  it.each([
    ['atlas_observations_v2', VlmAnalysis],
    ['reference_notes', RawExtraction],
  ])(
    '%s: every object is closed and fully required, only provider-safe keywords remain',
    (_, schema) => {
      const json = strictJsonSchema(schema);
      for (const node of nodes(json)) {
        for (const key of Object.keys(node))
          expect(PROVIDER_SCHEMA_KEYWORDS.has(key), key).toBe(true);
        if (node.type === 'object') {
          expect(node.additionalProperties).toBe(false);
          expect([...(node.required as string[])].sort()).toEqual(
            Object.keys(node.properties as Node).sort(),
          );
        }
      }
      expect(JSON.stringify(json)).not.toContain('x-atlas');
    },
  );

  it.each([
    ['atlas_observations_v2', VlmAnalysis],
    ['reference_notes', RawExtraction],
  ])(
    '%s: property check proves zod-valid outputs round-trip and shape mutations are rejected',
    (_, schema) => {
      const report = checkContractEquivalence(schema, { samples: 150, seed: 7 });
      expect(report.failures).toEqual([]);
      expect(report.roundTrips).toBe(150);
      expect(report.rejectedMutations).toBeGreaterThanOrEqual(150);
    },
  );

  it('encodes optional (non-nullable) keys as required T|null and restores absence before zod', () => {
    const schema = z.object({
      a: z.string(),
      b: z.number().int().min(2).optional(),
      c: z.string().nullable().optional(),
    });
    const contract = structuredOutputContract(schema);
    expect(contract.jsonSchema).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        c: { type: ['string', 'null'] },
      },
      required: ['a', 'b', 'c'],
      additionalProperties: false,
    });
    expect(contract.decode({ a: 'x', b: null, c: null })).toEqual({ a: 'x', c: null });
    expect(schema.parse(contract.decode({ a: 'x', b: null, c: null }))).toEqual({
      a: 'x',
      c: null,
    });
    // Value constraints stripped from the provider schema are still Atlas-enforced.
    expect(schema.safeParse(contract.decode({ a: 'x', b: 1, c: null })).success).toBe(false);
    expect(() => contract.decode({ a: 'x', b: null })).toThrow('Missing property');
    expect(() => contract.decode({ a: 'x', b: null, c: null, d: 1 })).toThrow('Unknown property');
    expect(() => contract.decode({ a: 'x', b: 1.5, c: null })).toThrow();
  });

  it.each([
    ['record', z.object({ a: z.record(z.string(), z.string()) })],
    ['unknown', z.object({ a: z.unknown() })],
    ['any', z.object({ a: z.any() })],
    ['open object', z.object({ a: z.string() }).loose()],
    ['tuple', z.object({ a: z.tuple([z.string(), z.number()]) })],
    ['non-object root', z.array(z.string())],
  ])('fails closed for an unrepresentable %s instead of a permissive fallback', (_, schema) => {
    expect(() => strictJsonSchema(schema)).toThrow('not representable');
  });

  it('type-checks union, integer and type-array nodes', () => {
    const schema = z.object({
      n: z.number().int(),
      s: z.string().nullable(),
      u: z.union([z.string(), z.number()]),
      o: z.union([z.object({ k: z.literal('a') }), z.object({ k: z.literal('b'), v: z.string() })]),
    });
    const json = strictJsonSchema(schema);
    const ok = { n: 1, s: null, u: 'a', o: { k: 'b', v: 'x' } };
    expect(() => validateStrictShape(ok, json)).not.toThrow();
    expect(() => validateStrictShape({ ...ok, n: 1.5 }, json)).toThrow();
    expect(() => validateStrictShape({ ...ok, s: 3 }, json)).toThrow();
    expect(() => validateStrictShape({ ...ok, u: true }, json)).toThrow('Unexpected JSON type');
    expect(() => validateStrictShape({ ...ok, o: { k: 'a', v: 'x' } }, json)).toThrow(
      'Invalid union',
    );
  });
});
