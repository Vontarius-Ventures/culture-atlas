import type { DiscoveryClaim } from './discovery-concepts';
import type { StoredSubject } from './types';

export interface SourceFeature {
  readonly id: string;
  readonly subjectId: string;
  readonly readingRev: number;
  readonly kind: 'object_form' | 'pattern' | 'construction' | 'style_family';
  readonly concept: string;
  readonly publicCue: string;
  readonly observationIds: readonly string[];
  readonly observations: readonly { id: string; region: StoredSubject['region'] | null; certainty: number }[];
  readonly claim: DiscoveryClaim;
}

export interface SourceFeaturePlan {
  readonly version: 'connection_source_feature_plan_v1';
  readonly readingRev: number;
  readonly features: readonly SourceFeature[];
}

export interface ConnectionSourceEvidence {
  version: 'connection_source_evidence_v1';
  readingRev: number;
  subjectId: string;
  observationIds: string[];
  featureIds: string[];
  publicCue: string;
}

/** JSONB may reorder object keys; order is not evidence. Duplicate IDs are invalid. */
export function sameSourceEvidence(a: ConnectionSourceEvidence | undefined, b: ConnectionSourceEvidence | undefined): boolean {
  const ids = (x: unknown): x is string[] => Array.isArray(x) && x.every((id) => typeof id === 'string') && new Set(x).size === x.length;
  return !!a && !!b && a.version === b.version && a.readingRev === b.readingRev && a.subjectId === b.subjectId &&
    a.publicCue === b.publicCue && ids(a.observationIds) && ids(a.featureIds) &&
    ids(b.observationIds) && ids(b.featureIds) &&
    [...a.observationIds].sort().join('\0') === [...b.observationIds].sort().join('\0') &&
    [...a.featureIds].sort().join('\0') === [...b.featureIds].sort().join('\0');
}

// Only object nouns leave this function: never a culture, maker, date, material or subtype.
const OBJECTS: readonly [RegExp, string][] = [
  [/\b(?:illustrations?|paintings?|portraits?)\b/i, 'Artwork'],
  [/\b(?:statues?|sculptures?|busts?|figurines?|(?:face|head) vessels?)\b/i, 'Sculptural object'],
  [/\b(?:sneakers?|trainers?)\b/i, 'Sneakers'],
  [/\b(?:armchairs?|chairs?)\b/i, 'Chairs'],
  [/\bdining sets?\b/i, 'Dining furniture'],
  [/\b(?:bed|beds|bedframes?)\b/i, 'Bed'],
  [/\b(?:sofas?|couches?)\b/i, 'Sofa'],
  [/\b(?:cabinets?|credenzas?|sideboards?)\b/i, 'Cabinet'],
  [/\b(?:tables?|desks?)\b/i, 'Table'],
  [/\bbowls?\b/i, 'Bowls'],
  [/\bmugs?\b/i, 'Mug'],
  [/\bcups?\b/i, 'Cup'],
  [/\b(?:jugs?|vases?|vessels?)\b/i, 'Vessel'],
  [/\b(?:kitchens?|sunrooms?|bedrooms?|rooms?|dining nooks?|lofts?|interiors?)\b/i, 'Room'],
  [/\b(?:palaces?|facades?|buildings?|houses?)\b/i, 'Building'],
  [/\b(?:sweatshirts?|hoodies?|sweaters?)\b/i, 'Sweatshirt'],
  [/\b(?:jackets?|coats?|blazers?)\b/i, 'Jacket'],
  [/\b(?:shirts?|tops?|tees?)\b/i, 'Top'],
  [/\b(?:dress(?:es)?|gowns?)\b/i, 'Dress'],
  [/\b(?:suits?|tuxedos?)\b/i, 'Suit'],
  [/\b(?:jeans|trousers?|pants?)\b/i, 'Trousers'],
  [/\b(?:bags?|crossbody|backpacks?)\b/i, 'Bag'],
  [/\b(?:rackets?|racquets?)\b/i, 'Racket'],
  [/\boutfits?\b/i, 'Clothing'],
  [/\b(?:ramen|noodles?|pasta|espresso|coffee|food|dish)\b/i, 'Food'],
  [/\bfurniture\b/i, 'Furniture'],
];

export function safeSubjectLabel(subject: Pick<StoredSubject, 'label'>): string {
  // Depicted artwork is the subject, not furniture/garments mentioned inside it.
  return OBJECTS.find(([re]) => re.test(subject.label))?.[1] ?? 'Object';
}

const VISUAL_FEATURES = [
  ['stripes', 'Stripes', 'pattern', /\bstrip(?:es?|ed|ing)\b/i],
  ['colour_block', 'Colour-block', 'pattern', /\bcolou?r[\s-]?block(?:ed|ing)?\b/i],
  ['rib_trim', 'Ribbed trim', 'construction', /\b(?:rib(?:bed)?(?:[\s-]+\w+){0,3}[\s-]+(?:trim|binding|cuffs?)|rib trim)\b/i],
  ['floral', 'Floral', 'pattern', /\bfloral|flower print\b/i],
  ['sequins', 'Sequins', 'construction', /\bsequin(?:s|ed)?\b/i],
  ['bow', 'Bow', 'construction', /\bbows?\b/i],
  ['canopy', 'Canopy', 'construction', /\b(?:canopy|four[\s-]poster)\b/i],
  ['bentwood', 'Bentwood', 'construction', /\bbentwood\b/i],
  ['glazing', 'Floor-to-ceiling glazing', 'construction', /\bfloor[\s-]to[\s-]ceiling (?:glaz|glass|window)/i],
  ['speckling', 'Speckling', 'pattern', /\bspeckl(?:ed|ing)\b/i],
  ['dipped_glaze', 'Half-dipped glaze', 'construction', /\b(?:half[\s-]dipped|dip(?:ped)? glaze)\b/i],
] as const;
const STYLE_FAMILIES = /^(?:streetwear|punk|grunge|gothic?|mod|varsity|mid[\s-]?century modern|industrial loft|scandinavian minimalism|japandi)$/i;

function signature(value: unknown): string {
  // Change detector, not an identity/authenticity claim or cryptographic digest.
  let h = 2166136261;
  for (const c of JSON.stringify(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16);
}

/** Pure compilation of retained evidence. No model calls, inferred observations or identities. */
export function compileSourceFeaturePlan(subjects: readonly StoredSubject[], readingRev: number): SourceFeaturePlan {
  const features: SourceFeature[] = [];
  if (!Number.isInteger(readingRev) || readingRev < 1) return { version: 'connection_source_feature_plan_v1', readingRev, features };
  for (const subject of subjects) {
    const raw = subject.observations ?? [];
    const observations = raw.filter((o) => o.id.trim() && o.kind !== 'text' && o.text.trim() &&
      (!o.region || (Object.values(o.region).every(Number.isFinite) && o.region.x >= 0 && o.region.y >= 0 &&
        o.region.w > 0 && o.region.h > 0 && o.region.x + o.region.w <= 1.000001 && o.region.y + o.region.h <= 1.000001)) &&
      Number.isFinite(o.certainty) && o.certainty >= 0.5 && o.certainty <= 1 &&
      raw.filter((x) => x.id === o.id).length === 1 &&
      !(o as { held?: boolean; retracted?: boolean }).held && !(o as { retracted?: boolean }).retracted);
    const add = (concept: string, publicCue: string, kind: SourceFeature['kind'], ids: readonly string[], claim: DiscoveryClaim) => {
      const bound = observations.filter((o) => ids.includes(o.id));
      if (!bound.length || bound.length !== new Set(ids).size) return;
      const id = `${subject.id}:${concept}:${signature([bound.map((o) =>
        [o.id, o.kind, o.text, o.certainty, o.region ? [o.region.x, o.region.y, o.region.w, o.region.h] : null]),
      [claim.slot, claim.name, claim.wording]])}`;
      if (features.some((f) => f.id === id)) return;
      features.push({ id, subjectId: subject.id, readingRev, kind, concept, publicCue,
        observationIds: bound.map((o) => o.id), observations: bound.map((o) => ({ id: o.id, region: o.region ?? null, certainty: o.certainty })), claim });
    };
    const noun = safeSubjectLabel(subject);
    // A retained non-text form/surface is needed even for the safe object noun.
    const form = observations.filter((o) => o.kind === 'form' || o.kind === 'construction');
    if (noun !== 'Object' && form.length)
      add('object_form', noun, 'object_form', form.map((o) => o.id), { slot: 'label', name: noun, wording: 'asserted' });
    for (const [concept, cue, kind, regex] of VISUAL_FEATURES) {
      if ([...subject.aesthetics, ...subject.construction].some((c) => (c.held || c.retracted) && regex.test(c.name))) continue;
      const direct = observations.filter((o) => {
        const match = regex.exec(o.text);
        return !!match && !/\b(?:no|not|without|lacks?|absent)\b[^.;]{0,35}$/i.test(o.text.slice(0, match.index));
      });
      if (direct.length) add(concept, cue, kind, direct.map((o) => o.id), { slot: 'construction', name: cue, wording: 'resembles' });
    }
    for (const slot of ['aesthetics', 'construction'] as const) {
      for (const claim of subject[slot]) {
        if (claim.held || claim.retracted || claim.basis !== 'visible' || !claim.evidence_ids?.length) continue;
        const ids = claim.evidence_ids;
        if (!ids.every((id) => observations.some((o) => o.id === id))) continue;
        if (slot === 'aesthetics' && STYLE_FAMILIES.test(claim.name) && new Set(ids).size >= 2)
          add(`style_${claim.name.toLowerCase().replace(/\W+/g, '_')}`, claim.name, 'style_family', ids,
            { slot, name: claim.name, wording: claim.wording });
        // A linked claim alone may normalize a construction only when a linked observation
        // also says it. Culture/lineage and a label are never independent visual evidence.
      }
    }
  }
  return { version: 'connection_source_feature_plan_v1', readingRev, features };
}

/** Derived construction claims are closed visual cues, not free-form observation text. */
export function observationDiscoveryClaims(subject: StoredSubject): DiscoveryClaim[] {
  return compileSourceFeaturePlan([subject], 1).features
    .filter((f) => f.kind === 'pattern' || f.kind === 'construction').map((f) => f.claim);
}

export function bindSourceEvidence(subject: StoredSubject, claim: DiscoveryClaim, readingRev: number | undefined, featureIds?: readonly string[]): ConnectionSourceEvidence | undefined {
  if (readingRev === undefined) return undefined;
  const plan = compileSourceFeaturePlan([subject], readingRev);
  const matching = plan.features.filter((f) => (!featureIds?.length || featureIds.includes(f.id)) &&
    (claim.slot === 'label' ? f.kind === 'object_form' && claim.name === safeSubjectLabel(subject) :
      f.claim.slot === claim.slot && f.claim.name === claim.name && f.claim.wording === claim.wording));
  if (!matching.length || (featureIds?.length && matching.length !== new Set(featureIds).size)) return undefined;
  return { version: 'connection_source_evidence_v1', readingRev, subjectId: subject.id,
    observationIds: [...new Set(matching.flatMap((f) => f.observationIds))],
    featureIds: matching.map((f) => f.id), publicCue: matching.map((f) => f.publicCue).join(' · ') };
}
