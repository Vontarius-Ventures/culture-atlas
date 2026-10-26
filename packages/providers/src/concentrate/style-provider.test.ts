import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { resolveFromWorkspace } from '../paths';
import { MemorySpendStore, ModelSpendLedger } from '../model-gateway/budget';
import { StructuredResponseRunner } from '../model-gateway/runner';
import { structuredOutputContract } from '../model-gateway/schema';
import type { StructuredTransport } from '../model-gateway/types';
import { STYLE_MAX_OUTPUT_TOKENS, STYLE_PROMPT_VERSION, STYLE_WIRE_SCHEMA, VlmStyleWireSchema, type VlmStyleObservationWire } from '../vlm/style';
import { ConcentrateVlmStyleReader } from './style-provider';
import { buildResponsesRequest } from './transport';
import { identity, limits, profile, response } from './test-fixtures';

describe('evidence-first style adapter, offline', () => {
  it('keeps active profile provenance aligned with the style-only wire and prompt', () => {
    const profiles = JSON.parse(readFileSync(resolveFromWorkspace('fixtures/concentrate/profiles.json'), 'utf8')) as {
      role: string; version: string; promptVersion: string; schemaVersion: string; maxOutputTokens: number;
    }[];
    expect(profiles.find((p) => p.role === 'vision_style')).toMatchObject({
      version: 'style-2',
      promptVersion: STYLE_PROMPT_VERSION,
      schemaVersion: STYLE_WIRE_SCHEMA,
      maxOutputTokens: STYLE_MAX_OUTPUT_TOKENS,
    });
  });

  it('makes one bounded call with the new wire schema, preserving normalized legacy shape', async () => {
    const wire: VlmStyleObservationWire = {
      schema: STYLE_WIRE_SCHEMA, usable: true, unusable_reason: 'none', summary: 'A glazed cup.',
      subjects: [{
        id: 's1', category: 'interior', label: 'Glazed cup', box: [0, 0, 1, 1], brand_name: '', brand_text: '',
      }],
      observations: [{ subject: 's1', id: 'o1', kind: 'surface', text: 'brown glaze', box: [0.1, 0.1, 0.4, 0.4], certainty: 0.9 }],
      claims: [],
      palette: [{ subject: 's1', swatch: 0, name: 'brown', role: 'accent', evidence: 'o1' }],
    };
    const transport = vi.fn<StructuredTransport>(async () => ({ ...response, text: JSON.stringify(wire) }));
    const runner = new StructuredResponseRunner(
      {
        ...profile, role: 'vision_style', promptVersion: STYLE_PROMPT_VERSION, schemaVersion: STYLE_WIRE_SCHEMA,
        maxOutputTokens: STYLE_MAX_OUTPUT_TOKENS, timeoutMs: 18_000,
        image: { maxBytes: 100_000, maxPixels: 10_000, maxDimension: 100, maxCount: 1 },
      },
      transport,
      new ModelSpendLedger(new MemorySpendStore(), limits),
      { identity, allowTestStore: true },
    );
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#775533' } }).jpeg().toBuffer();
    const result = await new ConcentrateVlmStyleReader(runner).readStyle({
      image: { bytes: image, mediaType: 'image/jpeg' }, vocabulary: {},
      swatches: [{ index: 0, hex: '#775533', share: 1 }],
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      schemaName: STYLE_WIRE_SCHEMA, maxOutputTokens: 2000,
    });
    const request = transport.mock.calls[0]![0];
    const body = buildResponsesRequest(request);
    expect(body).toMatchObject({
      max_output_tokens: 2000,
      text: { format: { name: STYLE_WIRE_SCHEMA, strict: true, schema: request.jsonSchema } },
    });
    // Assert the actual transport schema, not merely the Zod fixture's shape.
    let objects = 0;
    let arrays = 0;
    let maxObjectDepth = 0;
    const visit = (node: Record<string, unknown>, objectDepth = 0): void => {
      if (node.type === 'object') {
        objects++;
        objectDepth++;
        maxObjectDepth = Math.max(maxObjectDepth, objectDepth);
        expect(node.additionalProperties).toBe(false);
        const properties = node.properties as Record<string, Record<string, unknown>>;
        expect(node.required).toEqual(Object.keys(properties));
        Object.values(properties).forEach((child) => visit(child, objectDepth));
      }
      if (node.type === 'array') {
        arrays++;
        visit(node.items as Record<string, unknown>, objectDepth);
      }
    };
    visit(request.jsonSchema);
    expect({ objects, arrays, maxObjectDepth }).toEqual({ objects: 5, arrays: 6, maxObjectDepth: 2 });
    const schemaJson = JSON.stringify(request.jsonSchema);
    expect(Buffer.byteLength(schemaJson)).toBeLessThan(4000);
    expect(schemaJson).not.toMatch(/anyOf|oneOf|\$ref|\$defs|"null"/);
    expect(structuredOutputContract(VlmStyleWireSchema).decode(wire)).toEqual(wire);
    expect(() => structuredOutputContract(VlmStyleWireSchema).decode({ ...wire, claims: null })).toThrow();
    expect(result.reading.schema).toBe('atlas_style_reading_v1');
    expect(result.reading.subjects[0]?.observations?.[0]?.region).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
    expect(result.reading.subjects[0]?.palette[0]).toMatchObject({ role: 'accent', evidence_ids: ['o1'] });
    expect(result.image).toEqual({ width: 8, height: 8 });
  });
});
