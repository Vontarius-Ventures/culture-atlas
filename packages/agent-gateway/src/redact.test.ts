import { describe, expect, it } from 'vitest';
import { collectIds, redact, summarizeResult } from './redact';
import { TOOLS, routeForTool, toolAnnotations } from './tools';
import { toolInputJsonSchema } from './server';

describe('tool-call redaction', () => {
  it('drops credentials and bounds text', () => {
    const out = redact({
      instruction: `Use token cat_ab12cd34_${'x'.repeat(43)} please ${'y'.repeat(200)}`,
      authorization: 'Bearer abc',
      nested: { api_key: 'k', ids: ['00000000-0000-4000-8000-000000000001'] },
    }) as Record<string, unknown>;
    expect(out.authorization).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).api_key).toBe('[redacted]');
    expect(out.instruction).toMatch(/^Use token \[redacted\] please y+…$/);
    expect(String(out.instruction).length).toBeLessThanOrEqual(121);
  });

  it('collects ids from arguments and results', () => {
    const ids = collectIds({ a: '00000000-0000-4000-8000-00000000000A', b: [{ c: '00000000-0000-4000-8000-000000000002' }], d: 'not-an-id' });
    expect([...ids]).toEqual(['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000002']);
  });

  it('summarizes results in one line', () => {
    expect(summarizeResult('create_plan', { plan_id: 'p', job_id: 'j' })).toBe('started job j for plan p');
    expect(summarizeResult('list_collections', { collections: [1, 2] })).toBe('2 collection(s)');
    expect(summarizeResult('get_job', { id: 'j', state: 'running', stage: 'composing' })).toBe('job running (composing)');
  });
});

describe('tool catalogue contract', () => {
  it('every tool mirrors a REST route with the same scopes', () => {
    for (const t of TOOLS) {
      const route = routeForTool(t.name);
      expect([...t.scopes].sort(), t.name).toEqual([...route.scopes].sort());
      expect(route.response, t.name).toBeTruthy();
    }
  });

  it('advertises JSON input schemas and honest annotations', () => {
    for (const t of TOOLS) {
      const schema = toolInputJsonSchema(t);
      expect(schema.type, t.name).toBe('object');
    }
    expect(toolAnnotations('get_plan')).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(toolAnnotations('remove_collection_item')).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    const plan = toolInputJsonSchema(TOOLS.find((t) => t.name === 'create_plan')!);
    expect(plan.required).toEqual(expect.arrayContaining(['collection_id', 'expected_revision', 'item_ids', 'template']));
    expect(plan.additionalProperties).toBe(false);
  });
});
