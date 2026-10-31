import type { DiscoveryCard } from '../schemas/common';
import { validateConnectionPublication } from '../style/connection-publication';
import type { CandidateProof } from '../style/discovery-evidence';
import type { StyleMatch } from '../style/reasons';
import type { StoredStyleReading } from '../style/types';

export interface ConnectionProjectionRow {
  id: string;
  discovery_item_id: string;
  origin: string;
  rank: number;
  rail: 'more_like_this' | 'cross_domain' | null;
  subject_id: string | null;
  style_match: StyleMatch | null;
  external_ids: Record<string, unknown> | null;
}

const TARGETS: Readonly<Record<string, readonly string[]>> = {
  brand: ['urn:entity:brand'],
  film: ['urn:entity:movie', 'urn:entity:tv_show'],
  artist: ['urn:entity:artist'],
  track: ['urn:entity:recording'],
  place: ['urn:entity:place'],
};

/** Reads never fetch assets or run models. A reason or category is not proof. */
export function connectionCardEligible(row: ConnectionProjectionRow, card: DiscoveryCard, reading: StoredStyleReading | null): boolean {
  if (!reading || row.origin !== 'qloo' || !card.image?.url) return false;
  const proof: CandidateProof | undefined = row.style_match?.discovery_proof;
  const actualTypes = row.style_match?.actual_candidate_types;
  if (!proof || !proof.subjectId || !proof.targetType || !row.external_ids ||
    !Array.isArray(actualTypes) || !actualTypes.every(t => typeof t === 'string') || !actualTypes.includes(proof.targetType) ||
    row.external_ids.qloo !== proof.candidateId || !TARGETS[card.kind]?.includes(proof.targetType) ||
    (row.rail === 'more_like_this' && row.subject_id !== proof.subjectId) ||
    (row.subject_id !== null && row.subject_id !== proof.subjectId) ||
    (row.style_match?.subject_id && row.style_match.subject_id !== proof.subjectId)) return false;
  const subject = reading.subjects.find(s => s.id === proof.subjectId);
  if (!subject) return false;
  try {
    return validateConnectionPublication({ proof, subject, readingRev: reading.rev,
      candidateId: proof.candidateId, targetType: proof.targetType, imageUrl: card.image.url, origin: row.origin }).eligible;
  } catch {
    // Persisted historical/malformed JSON is untrusted, never a default success.
    return false;
  }
}

/** Validate before deduplication or limits, so an invalid duplicate cannot hide a valid row. */
export function validatedConnectionRows<T extends ConnectionProjectionRow>(rows: readonly T[], cards: ReadonlyMap<string, DiscoveryCard>, reading: StoredStyleReading | null): T[] {
  const eligible = rows.filter(row => {
    const card = cards.get(row.discovery_item_id);
    return card ? connectionCardEligible(row, card, reading) : false;
  }).sort((a, b) => {
    const taste = (r: T) => r.style_match?.discovery_proof?.relation === 'qloo_taste' ? 1 : 0;
    return taste(a) - taste(b) || Number(b.rail === 'more_like_this') - Number(a.rail === 'more_like_this') || a.rank - b.rank || a.id.localeCompare(b.id);
  });
  const seen = new Set<string>();
  let tasteShown = false;
  return eligible.filter(row => {
    if (seen.has(row.discovery_item_id)) return false;
    const taste = row.style_match?.discovery_proof?.relation === 'qloo_taste';
    if (taste && tasteShown) return false;
    seen.add(row.discovery_item_id);
    if (taste) tasteShown = true;
    return true;
  }).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}
