import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors';
import {
  attachStructuredResponseShapeIssues, getStructuredResponseFailureReason,
  getStructuredResponseShapeIssues, structuredResponseFailure,
  STRUCTURED_RESPONSE_SHAPE_DIAGNOSTIC_LIMIT, type StructuredResponseShapeIssue,
} from './diagnostics';

describe('content-free shape metadata boundary (offline)', () => {
  it('copies only allowlisted triplets, discards extra properties and does not retain callback objects', () => {
    const error = structuredResponseFailure('schema_shape');
    const source = {
      field: 'differences', rule: 'enum_mismatch', issueClass: 'invalid_value',
      message: 'SYNTHETIC_PRIVATE', path: ['SYNTHETIC_PRIVATE'], values: ['SYNTHETIC_PRIVATE'],
    };
    const rejected = [
      { field: 'SYNTHETIC_PRIVATE', rule: 'wrong_type', issueClass: 'invalid_type' },
      { field: 'differences', rule: 'SYNTHETIC_PRIVATE', issueClass: 'invalid_type' },
      { field: 'differences', rule: 'wrong_type', issueClass: 'SYNTHETIC_PRIVATE' },
    ];
    attachStructuredResponseShapeIssues(error, [source, ...rejected] as StructuredResponseShapeIssue[]);
    source.field = 'SYNTHETIC_PRIVATE';
    expect(getStructuredResponseShapeIssues(error)).toEqual([
      { field: 'differences', rule: 'enum_mismatch', issueClass: 'invalid_value' },
    ]);
    expect(getStructuredResponseFailureReason(error)).toBe('schema_shape');
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'invalid_response', message: 'Model output failed validation', cause: undefined });
    expect(JSON.stringify(getStructuredResponseShapeIssues(error))).not.toContain('SYNTHETIC_PRIVATE');
    expect(JSON.stringify(error)).not.toContain('issueClass');
  });
  it('caps metadata at eight entries and freezes the array and its entries', () => {
    const error = structuredResponseFailure('schema_shape');
    const issues: StructuredResponseShapeIssue[] = [
      { field: 'sameObjectType', rule: 'missing_field', issueClass: 'invalid_type' },
      { field: 'similarity', rule: 'missing_field', issueClass: 'invalid_value' },
      { field: 'matchedFeatures', rule: 'enum_mismatch', issueClass: 'invalid_value' },
      { field: 'matchedFeatures', rule: 'wrong_type', issueClass: 'invalid_value' },
      { field: 'matchedFeatures', rule: 'array_bounds', issueClass: 'too_big' },
      { field: 'differences', rule: 'enum_mismatch', issueClass: 'invalid_value' },
      { field: 'differences', rule: 'wrong_type', issueClass: 'invalid_value' },
      { field: 'differences', rule: 'array_bounds', issueClass: 'too_big' },
      { field: 'response', rule: 'unknown_fields', issueClass: 'unrecognized_keys' },
    ];
    attachStructuredResponseShapeIssues(error, issues);
    const safe = getStructuredResponseShapeIssues(error)!;
    expect(safe).toEqual(issues.slice(0, 8));
    expect(safe).toHaveLength(STRUCTURED_RESPONSE_SHAPE_DIAGNOSTIC_LIMIT);
    expect(Object.isFrozen(safe)).toBe(true);
    expect(safe.every(Object.isFrozen)).toBe(true);
    expect(() => { (safe as StructuredResponseShapeIssue[]).push(issues[0]!); }).toThrow();
  });
  it('deduplicates within the bounded prefix and never attaches to another failure stage', () => {
    const issues = [{ field: 'response', rule: 'wrong_type', issueClass: 'invalid_type' }] as const;
    const shape = structuredResponseFailure('schema_shape');
    attachStructuredResponseShapeIssues(shape, [...issues, ...issues]);
    expect(getStructuredResponseShapeIssues(shape)).toEqual(issues);
    const semantic = structuredResponseFailure('semantic_consistency');
    attachStructuredResponseShapeIssues(semantic, issues);
    expect(getStructuredResponseShapeIssues(semantic)).toBeUndefined();
    expect(getStructuredResponseShapeIssues({ ...shape })).toBeUndefined();
    expect(getStructuredResponseShapeIssues(new Error('schema_shape'))).toBeUndefined();
  });
});
