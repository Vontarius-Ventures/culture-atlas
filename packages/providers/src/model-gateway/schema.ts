import { z } from 'zod';
import { ProviderError } from '../errors';

type JsonSchema = Record<string, unknown>;
const invalid = () =>
  new ProviderError(
    'model-gateway',
    'bad_request',
    'Schema is not representable as strict structured output',
  );

/** No lossy "any" fallback. Optional keys become required; Atlas still validates the original schema. */
export function strictJsonSchema(schema: z.ZodType): JsonSchema {
  let json: JsonSchema;
  try {
    json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'throw' }) as JsonSchema;
  } catch {
    throw invalid();
  }
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const node = value as JsonSchema;
    // Unbounded dictionaries, unknown, and boolean schemas cannot be tightened equivalently.
    if (!node.type && !node.anyOf && !node.oneOf && !node.$ref && !node.enum && !node.const)
      throw invalid();
    if (node.type === 'object') {
      if (node.additionalProperties !== false) throw invalid();
      const properties = node.properties as Record<string, unknown> | undefined;
      if (!properties) throw invalid();
      node.required = Object.keys(properties);
      Object.values(properties).forEach(visit);
    }
    if (node.items) visit(node.items);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[key])) (node[key] as unknown[]).forEach(visit);
    }
    if (node.$defs) Object.values(node.$defs as JsonSchema).forEach(visit);
  }
  visit(json);
  if (json.type !== 'object') throw invalid();
  return json;
}

/** Enforce required keys and unknown-property rejection before Zod can strip/default them. */
export function validateStrictShape(value: unknown, schema: JsonSchema, root = schema): void {
  if (schema.$ref) {
    const ref = schema.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/')) throw invalid();
    let target: unknown = root;
    for (const key of ref.slice(2).split('/'))
      target = (target as JsonSchema)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (!target) throw invalid();
    validateStrictShape(value, target as JsonSchema, root);
    return;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    if (
      !alternatives.some((alternative) => {
        try {
          validateStrictShape(value, alternative as JsonSchema, root);
          return true;
        } catch {
          return false;
        }
      })
    )
      throw new Error('Invalid union');
    return;
  }
  if (schema.type === 'null' && value !== null) throw new Error('Expected null');
  if (schema.type === 'string' && typeof value !== 'string') throw new Error('Expected string');
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error('Expected boolean');
  if (
    (schema.type === 'number' || schema.type === 'integer') &&
    (typeof value !== 'number' || !Number.isFinite(value))
  )
    throw new Error('Expected number');
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) throw new Error('Invalid enum');
  if (Object.hasOwn(schema, 'const') && schema.const !== value) throw new Error('Invalid constant');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected object');
    const properties = schema.properties as Record<string, JsonSchema>;
    if (Object.keys(value).some((key) => !Object.hasOwn(properties, key)))
      throw new Error('Unknown property');
    for (const key of schema.required as string[])
      if (!Object.hasOwn(value, key)) throw new Error('Missing property');
    for (const [key, child] of Object.entries(properties))
      validateStrictShape((value as JsonSchema)[key], child, root);
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error('Expected array');
    value.forEach((child) => validateStrictShape(child, schema.items as JsonSchema, root));
  }
}
