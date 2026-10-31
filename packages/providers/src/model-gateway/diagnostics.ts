import { ProviderError, type ProviderErrorKind } from '../errors';

/** Local failure stage only; never a reconstruction of model content or intent. */
export type StructuredResponseFailureReason =
  | 'json_parse'
  | 'schema_shape'
  | 'semantic_consistency'
  | 'route_mismatch'
  | 'provider_error'
  | 'provider_incomplete'
  | 'provider_refusal';

const definitions = {
  json_parse: ['invalid_response', 'Model output failed validation'],
  schema_shape: ['invalid_response', 'Model output failed validation'],
  semantic_consistency: ['invalid_response', 'Model output failed validation'],
  route_mismatch: ['invalid_response', 'Returned route does not match qualified profile'],
  provider_error: ['invalid_response', 'Model response reported an error'],
  provider_incomplete: ['incomplete_response', 'Model output incomplete'],
  provider_refusal: ['content_rejected', 'Model declined analysis'],
} as const satisfies Record<StructuredResponseFailureReason, readonly [ProviderErrorKind, string]>;

// Keep metadata out of error serialization, causes, observers and the spend ledger.
// Only errors created here can acquire a reason; arbitrary error fields are ignored.
const reasons = new WeakMap<object, StructuredResponseFailureReason>();

export const STRUCTURED_RESPONSE_SHAPE_DIAGNOSTIC_LIMIT = 8;
/** Closed visual-wire names only, never a response-derived key or path. */
export type StructuredResponseShapeField =
  | 'response' | 'sameObjectType' | 'similarity' | 'matchedFeatures' | 'differences';
export type StructuredResponseShapeRule =
  | 'enum_mismatch' | 'missing_field' | 'wrong_type' | 'unknown_fields' | 'array_bounds';
export type StructuredResponseShapeIssueClass =
  | 'invalid_value' | 'invalid_type' | 'unrecognized_keys' | 'too_big' | 'too_small';
export interface StructuredResponseShapeIssue {
  readonly field: StructuredResponseShapeField;
  readonly rule: StructuredResponseShapeRule;
  readonly issueClass: StructuredResponseShapeIssueClass;
}
const shapeIssues = new WeakMap<object, readonly StructuredResponseShapeIssue[]>();
const fields: readonly string[] = ['response', 'sameObjectType', 'similarity', 'matchedFeatures', 'differences'];
const rules: readonly string[] = ['enum_mismatch', 'missing_field', 'wrong_type', 'unknown_fields', 'array_bounds'];
const issueClasses: readonly string[] = ['invalid_value', 'invalid_type', 'unrecognized_keys', 'too_big', 'too_small'];

/** Runner-internal; copy only allowlisted triplets, never retain callback objects. */
export function attachStructuredResponseShapeIssues(
  error: ProviderError,
  issues: readonly StructuredResponseShapeIssue[],
): void {
  if (reasons.get(error) !== 'schema_shape' || !Array.isArray(issues)) return;
  const safe: StructuredResponseShapeIssue[] = [];
  const seen = new Set<string>();
  // A bounded callback prefix is intentional, not an exhaustive issue census.
  for (const issue of issues.slice(0, STRUCTURED_RESPONSE_SHAPE_DIAGNOSTIC_LIMIT)) {
    if (!issue || typeof issue !== 'object') continue;
    const { field, rule, issueClass } = issue;
    if (!fields.includes(field) || !rules.includes(rule) || !issueClasses.includes(issueClass)) continue;
    const signature = `${field}:${rule}:${issueClass}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    safe.push(Object.freeze({ field, rule, issueClass }));
  }
  if (safe.length) shapeIssues.set(error, Object.freeze(safe));
}

/**
 * Original in-process error only, like the stage lookup below. At most eight
 * frozen, deduplicated, closed triplets. No raw Zod issues or dynamic strings.
 */
export function getStructuredResponseShapeIssues(
  error: unknown,
): readonly StructuredResponseShapeIssue[] | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? shapeIssues.get(error)
    : undefined;
}

/** Runner-internal factory. No raw response, caught error or dynamic message accepted. */
export function structuredResponseFailure(reason: StructuredResponseFailureReason): ProviderError {
  const [kind, message] = definitions[reason];
  const error = new ProviderError('model-gateway', kind, message);
  reasons.set(error, reason);
  return error;
}

/**
 * Safe, in-process projection for an authorized diagnostic caller. Unknown,
 * transport and pre-dispatch errors have no structured-response reason.
 * Does not inspect messages, causes or any property of the supplied value.
 * A serialized/copied/wrapped error intentionally loses this metadata.
 */
export function getStructuredResponseFailureReason(
  error: unknown,
): StructuredResponseFailureReason | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? reasons.get(error)
    : undefined;
}
