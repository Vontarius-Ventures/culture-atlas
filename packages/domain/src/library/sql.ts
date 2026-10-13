/**
 * Keyset-pagination helper: a timestamptz rendered with full microsecond
 * precision, so cursors never skip or repeat rows that share a millisecond.
 */
export function tsKey(column: string, alias: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`;
}
