import {
  STRUCTURED_RESPONSE_SHAPE_DIAGNOSTIC_LIMIT,
  type StructuredResponseShapeField, type StructuredResponseShapeIssue,
  type StructuredResponseShapeRule,
} from '../model-gateway/diagnostics';
import { VisualSimilarityWireSchema } from './schema';

const fields = ['sameObjectType', 'similarity', 'matchedFeatures', 'differences'] as const;

/**
 * Failure-only diagnostic, NOT a decoder or alternate acceptance path. Validate
 * with the unchanged wire schema, but inspect only seven entries per array:
 * enough to retain a max-six violation, with bounded item issue construction.
 * Unknown keys, raw paths, values, messages and enum options never leave here.
 */
export function diagnoseVisualSimilarityShape(value: unknown): readonly StructuredResponseShapeIssue[] {
  const object = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const bounded = object ? { ...object } : value;
  if (object) {
    for (const field of ['matchedFeatures', 'differences'] as const) {
      if (Array.isArray(object[field]))
        (bounded as Record<string, unknown>)[field] = object[field].slice(0, 7);
    }
  }
  const parsed = VisualSimilarityWireSchema.safeParse(bounded);
  if (parsed.success) return [];
  const safe: StructuredResponseShapeIssue[] = [];
  const seen = new Set<string>();
  for (const issue of parsed.error.issues) {
    let field: StructuredResponseShapeField = 'response';
    // Select constant field names, never copy a path or arbitrary key.
    for (const known of fields) if (issue.path[0] === known) field = known;
    let rule: StructuredResponseShapeRule;
    switch (issue.code) {
      case 'unrecognized_keys':
        field = 'response';
        rule = 'unknown_fields';
        break;
      case 'invalid_type':
      case 'invalid_value': {
        if (field !== 'response' && object && !Object.hasOwn(object, field)) {
          rule = 'missing_field';
        } else if (issue.code === 'invalid_value') {
          const item = field !== 'response' ? object?.[field] : undefined;
          const badValue = Array.isArray(item) && typeof issue.path[1] === 'number'
            ? item[issue.path[1]] : item;
          rule = typeof badValue === 'string' ? 'enum_mismatch' : 'wrong_type';
        } else rule = 'wrong_type';
        break;
      }
      case 'too_big':
      case 'too_small':
        if (field !== 'matchedFeatures' && field !== 'differences') continue;
        // Zod may also emit a size issue for a wrong-type string with .length.
        if (!Array.isArray(object?.[field])) continue;
        rule = 'array_bounds';
        break;
      default:
        continue;
    }
    const signature = `${field}:${rule}:${issue.code}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    safe.push({ field, rule, issueClass: issue.code });
    if (safe.length === STRUCTURED_RESPONSE_SHAPE_DIAGNOSTIC_LIMIT) break;
  }
  return safe;
}
