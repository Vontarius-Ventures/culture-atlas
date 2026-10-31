import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { identity, profile as baseProfile, response } from '../concentrate/test-fixtures';
import { createConcentrateTransport } from '../concentrate/transport';
import { ProviderError, isProviderError } from '../errors';
import { MemorySpendStore, ModelSpendLedger } from '../model-gateway/budget';
import {
  getStructuredResponseFailureReason, getStructuredResponseShapeIssues,
  STRUCTURED_RESPONSE_SHAPE_DIAGNOSTIC_LIMIT,
} from '../index';
import { StructuredResponseRunner } from '../model-gateway/runner';
import { structuredOutputContract } from '../model-gateway/schema';
import type { GatewayResponse, StructuredTransport } from '../model-gateway/types';
import { ConcentrateVisualSimilarity } from './provider';
import {
  VISUAL_MATCHED_FEATURES, VISUAL_DIFFERENCES, VISUAL_SIMILARITY_PROMPT_VERSION,
  VISUAL_SIMILARITY_SCHEMA_VERSION, VISUAL_SIMILARITY_SYSTEM_PROMPT,
  VisualSimilarityWireSchema, validateVisualSimilarity, type VisualSimilarityWire,
} from './schema';

// SYNTHETIC OFFLINE ONLY. These are not recovered live outputs or quality labels.
const negative: VisualSimilarityWire = {
  sameObjectType: false, similarity: 'none', matchedFeatures: [],
  differences: ['different object type'],
};
const contract = structuredOutputContract(VisualSimilarityWireSchema);
function validate(value: unknown): void {
  validateVisualSimilarity(VisualSimilarityWireSchema.parse(contract.decode(value)));
}

describe('visual negative-judgment diagnostics (synthetic offline)', () => {
  it('versions the completed instructions without changing the schema contract', () => {
    expect(VISUAL_SIMILARITY_PROMPT_VERSION).toBe('visual-similarity-v3');
    expect(VISUAL_SIMILARITY_SCHEMA_VERSION).toBe('atlas_visual_similarity_v1');
    const prompt = VISUAL_SIMILARITY_SYSTEM_PROMPT.replace(/\s+/g, ' ');
    for (const instruction of [
      'at most six entries', 'no duplicates within either matchedFeatures or differences',
      'Never include both similar and different descriptors for the same feature',
      'silhouette, proportions, visible color, visible pattern, surface appearance or component arrangement',
      'similarity=none requires matchedFeatures=[]',
      'every non-none similarity requires at least one matched feature',
      'sameObjectType=true must not include different object type in differences',
      'sameObjectType=false requires similarity=none and matchedFeatures=[]',
      'Strong requires at least two visible matched features',
    ]) expect(prompt).toContain(instruction);
    expect(VISUAL_SIMILARITY_SYSTEM_PROMPT).toContain(JSON.stringify(VISUAL_MATCHED_FEATURES));
    expect(VISUAL_SIMILARITY_SYSTEM_PROMPT).toContain(JSON.stringify(VISUAL_DIFFERENCES));
    expect(VISUAL_SIMILARITY_SYSTEM_PROMPT).toContain(JSON.stringify(negative));
    validate(JSON.parse(VISUAL_SIMILARITY_SYSTEM_PROMPT.split('\n').find((line) => line.startsWith('{"sameObjectType"'))!));
  });

  it('keeps the prompt-directed incompatible/uncertain paths satisfiable', () => {
    expect(VISUAL_SIMILARITY_SYSTEM_PROMPT).toContain(
      'types: sameObjectType=false, similarity=none, matchedFeatures=[]',
    );
    expect(VISUAL_SIMILARITY_SYSTEM_PROMPT).toContain(
      'choose none and insufficient visible detail',
    );
    validate(negative);
    validate({ ...negative, differences: ['insufficient visible detail'] });
    validate({ ...negative, sameObjectType: true, differences: ['insufficient visible detail'] });
  });

  it.each([
    { ...negative, differences: [] },
    { ...negative, differences: ['different object type', 'different silhouette', 'different proportions', 'different visible color', 'source partly obscured', 'candidate partly obscured'] },
    { ...negative, sameObjectType: true, differences: ['different silhouette'] },
    { ...negative, sameObjectType: true, similarity: 'weak', matchedFeatures: ['similar silhouette'], differences: ['different visible color'] },
    { ...negative, sameObjectType: true, similarity: 'strong', matchedFeatures: ['similar silhouette', 'similar proportions'], differences: [] },
  ])('accepts consistent negative/boundary/positive fixture %# unchanged', (fixture) => {
    expect(() => validate(fixture)).not.toThrow();
    expect(contract.decode(fixture)).toEqual(fixture);
  });

  it.each([
    { ...negative, similarity: 'weak', matchedFeatures: ['similar silhouette'] },
    { ...negative, matchedFeatures: ['similar visible color'] },
    { ...negative, sameObjectType: true },
    { ...negative, sameObjectType: true, similarity: 'weak', differences: [] },
    { ...negative, sameObjectType: true, similarity: 'strong', matchedFeatures: ['similar silhouette'], differences: [] },
    { ...negative, differences: ['different object type', 'different object type'] },
    { ...negative, sameObjectType: true, similarity: 'weak', matchedFeatures: ['similar silhouette', 'similar silhouette'], differences: [] },
  ])('rejects structurally valid but contradictory fixture %#', (fixture) => {
    expect(() => contract.decode(fixture)).not.toThrow();
    expect(VisualSimilarityWireSchema.safeParse(fixture).success).toBe(true);
    expect(() => validate(fixture)).toThrow('Inconsistent visual comparison');
  });

  it.each(VISUAL_MATCHED_FEATURES)('rejects matched/different contradiction: %s', (feature) => {
    const fixture = {
      sameObjectType: true, similarity: 'weak', matchedFeatures: [feature],
      differences: [feature.replace('similar ', 'different ')],
    };
    expect(VisualSimilarityWireSchema.safeParse(fixture).success).toBe(true);
    expect(() => validate(fixture)).toThrow('Inconsistent visual comparison');
  });

  it('enforces the local six-difference cap even though the provider schema omits maxItems', () => {
    const fixture = {
      ...negative,
      differences: ['different object type', 'different silhouette', 'different proportions',
        'different visible color', 'different visible pattern', 'source partly obscured',
        'candidate partly obscured'],
    };
    expect(() => contract.decode(fixture)).not.toThrow();
    expect(VisualSimilarityWireSchema.safeParse(fixture).success).toBe(false);
    expect(() => validate(fixture)).toThrow();
  });
});

async function compareSynthetic(body: Partial<GatewayResponse>, throughTransport = false) {
  const profile = {
    ...baseProfile, role: 'vision_similarity' as const, version: 'synthetic-negative-diagnostic',
    promptVersion: VISUAL_SIMILARITY_PROMPT_VERSION, schemaVersion: VISUAL_SIMILARITY_SCHEMA_VERSION,
    timeoutMs: 5000,
    image: { maxBytes: 200_000, maxPixels: 1024 * 544, maxDimension: 1024, maxCount: 1 },
  };
  const store = new MemorySpendStore();
  const ledger = new ModelSpendLedger(store, {
    dailyMicros: 10_000, accountDailyMicros: 10_000,
    maxUnknownMicros: 10_000, accountDailyAnalyses: 10,
  });
  const syntheticResponse = {
    ...response, text: JSON.stringify(negative),
    // Token counts are metadata, not evidence of semantic validity or truncation.
    usage: { inputTokens: 2088, outputTokens: 78 }, ...body,
  };
  // Injected fetch only: exercise actual HTTP-body construction without networking.
  const fakeFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    model: profile.model, status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: syntheticResponse.text }] }],
  })));
  const send = vi.fn<StructuredTransport>(throughTransport
    ? createConcentrateTransport({ apiKey: 'SYNTHETIC-OFFLINE', fetch: fakeFetch })
    : async () => syntheticResponse);
  const provider = new ConcentrateVisualSimilarity(
    new StructuredResponseRunner(profile, send, ledger, { allowTestStore: true }),
    true,
  );
  const image = (background: string) =>
    sharp({ create: { width: 40, height: 40, channels: 3, background } }).png().toBuffer();
  const sourceImage = await image('#ff0000');
  const candidateImage = await image('#0000ff');
  const onAttempt = vi.fn();
  const result = await provider.compare({
    sourceImage, candidateImage, sourceRegion: { x: 0, y: 0, w: 1, h: 1 },
    subjectLabel: 'SYNTHETIC chair label', candidateLabel: 'SYNTHETIC vase label',
  }, { modelIdentity: identity, maxRetries: 1, onAttempt }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  return { ...result, send, fakeFetch, onAttempt, state: await store.read() };
}

describe('visual adapter error classification (mock transport, isolated memory ledger)', () => {
  it('publishes a valid incompatible judgment without converting it into an error or a match', async () => {
    const { value, error, send, state } = await compareSynthetic({});
    expect(error).toBeUndefined();
    expect(getStructuredResponseFailureReason(error)).toBeUndefined();
    expect(getStructuredResponseShapeIssues(error)).toBeUndefined();
    expect(value).toMatchObject({ ...negative, experimental: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].maxOutputTokens).toBe(600);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({
      outcome: 'complete', state: 'unknown', costMicros: null,
      usage: { inputTokens: 2088, outputTokens: 78 },
    });
  });

  it.each([
    { ...negative, differences: [] },
    { ...negative, differences: ['insufficient visible detail'] },
    { ...negative, sameObjectType: true, differences: ['insufficient visible detail'] },
  ])('preserves valid none/uncertain judgments through the adapter %#', async (fixture) => {
    const { value, error, send, state } = await compareSynthetic({ text: JSON.stringify(fixture) });
    expect(error).toBeUndefined();
    expect(value).toMatchObject(fixture);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.attempts[0]).toMatchObject({ outcome: 'complete', state: 'unknown', costMicros: null });
  });

  it.each([
    ['malformed JSON', { text: '{"SYNTHETIC_PRIVATE_BODY":' }, 'invalid_response', 'json_parse'],
    ['wrong JSON type', { text: JSON.stringify({ ...negative, sameObjectType: 'false' }) }, 'invalid_response', 'schema_shape'],
    ['unknown descriptor', { text: JSON.stringify({ ...negative, differences: ['SYNTHETIC_PRIVATE_BODY'] }) }, 'invalid_response', 'schema_shape'],
    ['unknown field', { text: JSON.stringify({ ...negative, explanation: 'SYNTHETIC_PRIVATE_BODY' }) }, 'invalid_response', 'schema_shape'],
    ['local array cap', { text: JSON.stringify({ ...negative, differences: Array(7).fill('different object type') }) }, 'invalid_response', 'schema_shape'],
    ['cross-field contradiction', { text: JSON.stringify({ ...negative, matchedFeatures: ['similar silhouette'] }) }, 'invalid_response', 'semantic_consistency'],
    ['reported model error', { outcome: 'error', text: 'SYNTHETIC_PRIVATE_BODY' }, 'invalid_response', 'provider_error'],
    ['returned model mismatch', { model: 'fixture/wrong-model', text: 'SYNTHETIC_PRIVATE_BODY' }, 'invalid_response', 'route_mismatch'],
    ['returned provider mismatch', { actualProvider: 'wrong-provider', text: 'SYNTHETIC_PRIVATE_BODY' }, 'invalid_response', 'route_mismatch'],
    ['reported incomplete', { outcome: 'incomplete', text: 'SYNTHETIC_PRIVATE_BODY' }, 'incomplete_response', 'provider_incomplete'],
    ['reported refusal', { outcome: 'refusal', text: 'SYNTHETIC_PRIVATE_BODY' }, 'content_rejected', 'provider_refusal'],
  ] as const)('classifies %s without retries or content logging', async (_label, body, kind, reason) => {
    const { value, error, send, onAttempt, state } = await compareSynthetic(body);
    expect(value).toBeUndefined();
    expect(isProviderError(error)).toBe(true);
    if (!(error instanceof ProviderError)) throw new Error('Expected typed provider failure');
    expect(error.kind).toBe(kind);
    expect(error).not.toHaveProperty('code');
    // Safe caller projection: no message/cause/raw body/labels or arbitrary .code.
    const safe = {
      error_kind: isProviderError(error) ? error.kind : 'unclassified',
      response_failure_reason: getStructuredResponseFailureReason(error) ?? null,
    };
    expect(safe).toEqual({ error_kind: kind, response_failure_reason: reason });
    if (reason !== 'schema_shape') expect(getStructuredResponseShapeIssues(error)).toBeUndefined();
    // Reasons are opt-in in-process metadata, not additional public error fields.
    expect(error.constructor).toBe(ProviderError);
    expect(error.name).toBe('ProviderError');
    expect(error.cause).toBeUndefined();
    expect(error).not.toHaveProperty('response_failure_reason');
    expect(getStructuredResponseFailureReason(JSON.parse(JSON.stringify(error)))).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ error: kind }));
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({
      outcome: kind, state: 'unknown', costMicros: null,
      usage: { inputTokens: 2088, outputTokens: 78 },
    });
    const diagnostics = JSON.stringify({ safe, state, events: onAttempt.mock.calls, error });
    expect(diagnostics).not.toContain('SYNTHETIC chair label');
    expect(diagnostics).not.toContain('SYNTHETIC_PRIVATE_BODY');
    expect(diagnostics).not.toContain('"sameObjectType"');
    expect(JSON.stringify(onAttempt.mock.calls)).not.toContain(reason);
    if (reason === 'route_mismatch') {
      expect(state.circuits).toMatchObject({ vision_similarity: { reason: 'route_mismatch' } });
    } else expect(JSON.stringify(state)).not.toContain(reason);
    if (kind === 'invalid_response') {
      expect(error.retryable).toBe(false);
      // Messages remain backward compatible; raw validation details are discarded.
      if (['json_parse', 'schema_shape', 'semantic_consistency'].includes(reason)) {
        expect(error.message).toBe('Model output failed validation');
        expect(error.cause).toBeUndefined();
        expect(state.circuits).toEqual({});
      }
    }
  });

  it('does not inspect unknown errors, arbitrary reason properties, messages or causes', () => {
    const read = vi.fn(() => { throw new Error('Must not inspect'); });
    const hostile = Object.defineProperties({}, {
      message: { get: read }, cause: { get: read },
      kind: { get: read }, response_failure_reason: { get: read },
    });
    for (const error of [
      undefined, null, 1, 'SYNTHETIC_PRIVATE_BODY', hostile,
      { kind: 'invalid_response', response_failure_reason: 'json_parse' },
      new Error('json_parse'),
      new ProviderError('synthetic', 'invalid_response', 'semantic_consistency', {
        cause: 'SYNTHETIC_PRIVATE_BODY',
      }),
    ]) {
      expect(getStructuredResponseFailureReason(error)).toBeUndefined();
      expect(getStructuredResponseShapeIssues(error)).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe('visual generated request and finite shape details (offline only)', () => {
  it('retains every exact enum in the real serialized Responses request body', async () => {
    const { fakeFetch, send, value, error } = await compareSynthetic({}, true);
    expect(error).toBeUndefined();
    expect(value).toMatchObject(negative);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fakeFetch.mock.calls[0]![1]!.body as string);
    expect(body.text.format).toMatchObject({
      type: 'json_schema', strict: true, name: 'atlas_visual_similarity_v1',
    });
    expect(body.text.format.schema).toEqual({
      type: 'object', additionalProperties: false,
      required: ['sameObjectType', 'similarity', 'matchedFeatures', 'differences'],
      properties: {
        sameObjectType: { type: 'boolean' },
        similarity: { type: 'string', enum: ['strong', 'moderate', 'weak', 'none'] },
        matchedFeatures: { type: 'array', items: { type: 'string', enum: [
          'similar silhouette', 'similar proportions', 'similar visible color',
          'similar visible pattern', 'similar surface appearance', 'similar component arrangement',
        ] } },
        differences: { type: 'array', items: { type: 'string', enum: [
          'different silhouette', 'different proportions', 'different visible color',
          'different visible pattern', 'different surface appearance', 'different component arrangement',
          'different object type', 'source partly obscured', 'candidate partly obscured',
          'insufficient visible detail',
        ] } },
      },
    });
    expect(body.instructions).toBe(VISUAL_SIMILARITY_SYSTEM_PROMPT);
    expect(body).not.toHaveProperty('diagnoseShape');
    expect(body.max_output_tokens).toBe(600);
    expect(body.stream).toBe(false);
  });

  it.each([
    [null, 'response', 'wrong_type', 'invalid_type'],
    [[], 'response', 'wrong_type', 'invalid_type'],
    [{ similarity: 'none', matchedFeatures: [], differences: [] }, 'sameObjectType', 'missing_field', 'invalid_type'],
    [{ sameObjectType: false, matchedFeatures: [], differences: [] }, 'similarity', 'missing_field', 'invalid_value'],
    [{ sameObjectType: false, similarity: 'none', differences: [] }, 'matchedFeatures', 'missing_field', 'invalid_type'],
    [{ sameObjectType: false, similarity: 'none', matchedFeatures: [] }, 'differences', 'missing_field', 'invalid_type'],
    [{ ...negative, sameObjectType: 'SYNTHETIC_PRIVATE_VALUE' }, 'sameObjectType', 'wrong_type', 'invalid_type'],
    [{ ...negative, similarity: 7 }, 'similarity', 'wrong_type', 'invalid_value'],
    [{ ...negative, similarity: 'SYNTHETIC_PRIVATE_VALUE' }, 'similarity', 'enum_mismatch', 'invalid_value'],
    [{ ...negative, matchedFeatures: 'SYNTHETIC_PRIVATE_VALUE' }, 'matchedFeatures', 'wrong_type', 'invalid_type'],
    [{ ...negative, differences: {} }, 'differences', 'wrong_type', 'invalid_type'],
    [{ ...negative, matchedFeatures: ['SYNTHETIC_PRIVATE_VALUE'] }, 'matchedFeatures', 'enum_mismatch', 'invalid_value'],
    [{ ...negative, differences: ['SYNTHETIC_PRIVATE_VALUE'] }, 'differences', 'enum_mismatch', 'invalid_value'],
    [{ ...negative, differences: [{ SYNTHETIC_PRIVATE_KEY: 'SYNTHETIC_PRIVATE_VALUE' }] }, 'differences', 'wrong_type', 'invalid_value'],
    [{ ...negative, 'SYNTHETIC_PRIVATE_KEY.paths[3]': 'SYNTHETIC_PRIVATE_VALUE' }, 'response', 'unknown_fields', 'unrecognized_keys'],
    [{ ...negative, matchedFeatures: Array(7).fill('similar silhouette') }, 'matchedFeatures', 'array_bounds', 'too_big'],
    [{ ...negative, differences: Array(7).fill('different object type') }, 'differences', 'array_bounds', 'too_big'],
  ] as const)('exposes only closed shape triplets for synthetic case %#', async (output, field, rule, issueClass) => {
    const { value, error, send, state, onAttempt } = await compareSynthetic({ text: JSON.stringify(output) });
    expect(value).toBeUndefined();
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'invalid_response', message: 'Model output failed validation', cause: undefined });
    expect(getStructuredResponseFailureReason(error)).toBe('schema_shape');
    const issues = getStructuredResponseShapeIssues(error);
    expect(issues).toEqual([{ field, rule, issueClass }]);
    expect(Object.isFrozen(issues)).toBe(true);
    expect(Object.isFrozen(issues![0])).toBe(true);
    const safe = JSON.stringify(issues);
    for (const forbidden of ['SYNTHETIC_PRIVATE', 'path', 'message', 'expected', 'cause', '"keys"', '"values"'])
      expect(safe).not.toContain(forbidden);
    expect(Object.keys(issues![0]!)).toEqual(['field', 'rule', 'issueClass']);
    expect(getStructuredResponseShapeIssues(JSON.parse(JSON.stringify(error)))).toBeUndefined();
    expect(JSON.stringify({ state, events: onAttempt.mock.calls, error })).not.toContain('SYNTHETIC_PRIVATE');
    expect(JSON.stringify({ state, events: onAttempt.mock.calls, error })).not.toContain('"issueClass"');
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.attempts[0]).toMatchObject({ outcome: 'invalid_response', state: 'unknown', costMicros: null });
  });

  it.each(['different objects', 'Different object type', 'different object type '])(
    'never normalizes unknown enum variant %# into a valid negative',
    async (descriptor) => {
      const { value, error } = await compareSynthetic({
        text: JSON.stringify({ ...negative, differences: [descriptor] }),
      });
      expect(value).toBeUndefined();
      expect(getStructuredResponseShapeIssues(error)).toEqual([
        { field: 'differences', rule: 'enum_mismatch', issueClass: 'invalid_value' },
      ]);
    },
  );

  it('bounds and deduplicates repeated array issue signatures without mutating the input', async () => {
    const output = {
      ...negative,
      matchedFeatures: Array(2000).fill('SYNTHETIC_PRIVATE_VALUE'),
      differences: Array(2000).fill('SYNTHETIC_PRIVATE_VALUE'),
    };
    const { error } = await compareSynthetic({ text: JSON.stringify(output) });
    const issues = getStructuredResponseShapeIssues(error)!;
    expect(issues.length).toBeLessThanOrEqual(STRUCTURED_RESPONSE_SHAPE_DIAGNOSTIC_LIMIT);
    expect(issues).toEqual([
      { field: 'matchedFeatures', rule: 'enum_mismatch', issueClass: 'invalid_value' },
      { field: 'matchedFeatures', rule: 'array_bounds', issueClass: 'too_big' },
      { field: 'differences', rule: 'enum_mismatch', issueClass: 'invalid_value' },
      { field: 'differences', rule: 'array_bounds', issueClass: 'too_big' },
    ]);
    expect(output.matchedFeatures).toHaveLength(2000);
    expect(output.differences).toHaveLength(2000);
  });
});
