import { z } from 'zod';
import { ProviderError } from '../errors';

type JsonSchema = Record<string, unknown>;
const invalid = () =>
  new ProviderError(
    'model-gateway',
    'bad_request',
    'Schema is not representable as strict structured output',
  );

/**
 * Value constraints that strict structured-output routes commonly reject or
 * ignore. They are removed from the PROVIDER schema only; Atlas still enforces
 * every one of them because the original zod schema validates the decoded
 * output. The provider schema is therefore a structural superset of the zod
 * output type and never weaker than Atlas's own post-validation.
 */
const ATLAS_ENFORCED_KEYWORDS = [
  '$schema',
  'default',
  'examples',
  'title',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const;
/** Keywords whose semantics cannot be expressed or post-validated equivalently. */
const UNSUPPORTED_KEYWORDS = [
  'not',
  'if',
  'then',
  'else',
  'allOf',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'prefixItems',
  'contains',
  'dependentRequired',
  'dependentSchemas',
  'minProperties',
  'maxProperties',
  'contentEncoding',
  'contentMediaType',
] as const;
/** Every keyword a provider schema may contain after the transform. */
export const PROVIDER_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'enum',
  'const',
  'description',
  '$ref',
  '$defs',
]);
const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean', 'null']);
/** Internal-only marker: optional (non-nullable) keys encoded as required `T | null`. */
const OPTIONAL_NULL = 'x-atlas-optional-null';

export interface StructuredOutputContract {
  /** Sent as `text.format.schema`: strict, closed objects, every key required. */
  readonly jsonSchema: JsonSchema;
  /**
   * Strict-shape validation plus the inverse transform: rejects unknown/missing
   * keys and wrong JSON types, then restores keys the zod schema marks optional.
   * The result must still pass the original zod schema (and semantic checks).
   */
  decode(value: unknown): unknown;
  /** Forward transform of a zod-valid output value (fixtures, qualification). */
  encode(value: unknown): unknown;
}

function acceptsNull(node: JsonSchema): boolean {
  if (node.type === 'null') return true;
  if (Array.isArray(node.type) && node.type.includes('null')) return true;
  const alternatives = node.anyOf;
  return Array.isArray(alternatives) && alternatives.some((a) => acceptsNull(a as JsonSchema));
}

function transform(node: unknown): JsonSchema {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw invalid();
  const source = node as JsonSchema;
  for (const key of UNSUPPORTED_KEYWORDS) if (Object.hasOwn(source, key)) throw invalid();
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(source)) {
    if ((ATLAS_ENFORCED_KEYWORDS as readonly string[]).includes(key)) continue;
    if (key === 'oneOf') out.anyOf = value;
    else out[key] = value;
  }
  for (const key of Object.keys(out)) if (!PROVIDER_SCHEMA_KEYWORDS.has(key)) throw invalid();
  // Unbounded dictionaries, unknown and "any" cannot be tightened equivalently.
  if (!out.type && !out.anyOf && !out.$ref && !out.enum && !Object.hasOwn(out, 'const'))
    throw invalid();
  if (out.type !== undefined) {
    const types = Array.isArray(out.type) ? out.type : [out.type];
    if (
      !types.length ||
      types.some(
        (t) => typeof t !== 'string' || (!PRIMITIVES.has(t) && t !== 'object' && t !== 'array'),
      ) ||
      (types.length > 1 && types.some((t) => t === 'object' || t === 'array'))
    )
      throw invalid();
  }
  if (out.type === 'object') {
    if (out.additionalProperties !== false) throw invalid();
    const properties = out.properties as Record<string, unknown> | undefined;
    if (!properties || typeof properties !== 'object') throw invalid();
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    const next: Record<string, JsonSchema> = {};
    const optionalNull: string[] = [];
    for (const [key, child] of Object.entries(properties)) {
      const converted = transform(child);
      if (!required.has(key) && !acceptsNull(converted)) {
        next[key] = { anyOf: [converted, { type: 'null' }] };
        optionalNull.push(key);
      } else next[key] = converted;
    }
    out.properties = next;
    out.required = Object.keys(next);
    if (optionalNull.length) out[OPTIONAL_NULL] = optionalNull;
  } else if (out.properties || out.required || Object.hasOwn(out, 'additionalProperties'))
    throw invalid();
  if (out.type === 'array') {
    if (!out.items || Array.isArray(out.items)) throw invalid();
    out.items = transform(out.items);
  } else if (out.items) throw invalid();
  if (out.anyOf !== undefined) {
    if (!Array.isArray(out.anyOf) || !out.anyOf.length) throw invalid();
    out.anyOf = (out.anyOf as unknown[]).map(transform);
  }
  if (out.$defs !== undefined) {
    if (!out.$defs || typeof out.$defs !== 'object') throw invalid();
    out.$defs = Object.fromEntries(
      Object.entries(out.$defs as Record<string, unknown>).map(([k, v]) => [k, transform(v)]),
    );
  }
  if (out.$ref !== undefined && (typeof out.$ref !== 'string' || !out.$ref.startsWith('#/')))
    throw invalid();
  return out;
}

/** Remove internal markers: the provider never sees Atlas-only annotations. */
function publicSchema(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === OPTIONAL_NULL) continue;
    if (key === 'properties' || key === '$defs')
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([k, v]) => [k, publicSchema(v)]),
      );
    else if (key === 'items') out[key] = publicSchema(value as JsonSchema);
    else if (key === 'anyOf') out[key] = (value as JsonSchema[]).map(publicSchema);
    else out[key] = value;
  }
  return out;
}

function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw invalid();
  let target: unknown = root;
  for (const key of ref.slice(2).split('/'))
    target = (target as JsonSchema | undefined)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (!target || typeof target !== 'object') throw invalid();
  return target as JsonSchema;
}

function checkType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

/**
 * Walks `value` against an (internal or provider) strict schema. Throws on any
 * mismatch. With `restore`, returns a copy where optional keys encoded as null
 * are removed again (the inverse of the transform).
 */
function walk(value: unknown, schema: JsonSchema, root: JsonSchema, restore: boolean): unknown {
  if (schema.$ref) return walk(value, resolveRef(schema, root), root, restore);
  const alternatives = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(alternatives)) {
    for (const alternative of alternatives) {
      try {
        return walk(value, alternative, root, restore);
      } catch {
        // try the next alternative
      }
    }
    throw new Error('Invalid union');
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => checkType(value, t))) throw new Error('Unexpected JSON type');
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) throw new Error('Invalid enum');
  if (Object.hasOwn(schema, 'const') && schema.const !== value) throw new Error('Invalid constant');
  if (schema.type === 'object') {
    const object = value as JsonSchema;
    const properties = schema.properties as Record<string, JsonSchema>;
    if (Object.keys(object).some((key) => !Object.hasOwn(properties, key)))
      throw new Error('Unknown property');
    for (const key of schema.required as string[])
      if (!Object.hasOwn(object, key)) throw new Error('Missing property');
    const optionalNull = new Set((schema[OPTIONAL_NULL] as string[] | undefined) ?? []);
    const out: JsonSchema = {};
    for (const [key, child] of Object.entries(properties)) {
      const decoded = walk(object[key], child, root, restore);
      if (restore && optionalNull.has(key) && decoded === null) continue;
      out[key] = decoded;
    }
    return out;
  }
  if (schema.type === 'array')
    return (value as unknown[]).map((child) =>
      walk(child, schema.items as JsonSchema, root, restore),
    );
  return value;
}

/** Forward transform for fixtures: absent optional keys become explicit nulls. */
function encodeValue(value: unknown, schema: JsonSchema, root: JsonSchema): unknown {
  if (schema.$ref) return encodeValue(value, resolveRef(schema, root), root);
  const alternatives = schema.anyOf as JsonSchema[] | undefined;
  if (Array.isArray(alternatives)) {
    for (const alternative of alternatives) {
      try {
        const encoded = encodeValue(value, alternative, root);
        walk(encoded, alternative, root, false);
        return encoded;
      } catch {
        // try the next alternative
      }
    }
    throw new Error('Value does not match any alternative');
  }
  if (schema.type === 'object' && checkType(value, 'object')) {
    const properties = schema.properties as Record<string, JsonSchema>;
    const optionalNull = new Set((schema[OPTIONAL_NULL] as string[] | undefined) ?? []);
    const object = value as JsonSchema;
    const out: JsonSchema = {};
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(object, key) || object[key] === undefined) {
        if (!optionalNull.has(key) && !acceptsNull(child)) throw new Error('Missing property');
        out[key] = null;
      } else out[key] = encodeValue(object[key], child, root);
    }
    for (const key of Object.keys(object))
      if (!Object.hasOwn(properties, key)) throw new Error('Unknown property');
    return out;
  }
  if (schema.type === 'array' && Array.isArray(value))
    return value.map((child) => encodeValue(child, schema.items as JsonSchema, root));
  return value;
}

/**
 * Converts an Atlas zod schema into a provider-compatible strict JSON Schema
 * (`additionalProperties:false` and every key required on every object) plus
 * its exact inverse. Equivalence (proven by property tests in schema.test.ts
 * and the domain gateway-schema tests):
 *  - every zod-valid output value encodes to a value the provider schema
 *    accepts, and decodes back to the same value;
 *  - anything the provider schema rejects for shape (unknown/missing keys,
 *    wrong JSON types) is rejected before zod; anything that passes shape is
 *    still parsed by the ORIGINAL zod schema, so value constraints removed
 *    from the provider schema are enforced by Atlas.
 * Unrepresentable schemas (records, unknown/any, intersections, tuples, open
 * objects) fail before dispatch. There is no permissive `{type:object}` fallback.
 */
export function structuredOutputContract(schema: z.ZodType): StructuredOutputContract {
  let json: JsonSchema;
  try {
    json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'throw' }) as JsonSchema;
  } catch {
    throw invalid();
  }
  const internal = transform(json);
  if (internal.type !== 'object') throw invalid();
  const provider = publicSchema(internal);
  return {
    jsonSchema: provider,
    decode: (value) => walk(value, internal, internal, true),
    encode: (value) => encodeValue(value, internal, internal),
  };
}

/** Provider-facing strict schema only (see structuredOutputContract). */
export function strictJsonSchema(schema: z.ZodType): JsonSchema {
  return structuredOutputContract(schema).jsonSchema;
}

/** Enforce required keys and unknown-property rejection before Zod can strip/default them. */
export function validateStrictShape(value: unknown, schema: JsonSchema, root = schema): void {
  walk(value, schema, root, false);
}
