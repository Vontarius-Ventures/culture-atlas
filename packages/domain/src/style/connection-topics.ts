import { discoveryClaims, type DiscoveryClaim } from './discovery-concepts';
import type { StoredSubject } from './types';
import { compileSourceFeaturePlan, observationDiscoveryClaims } from './source-feature-plan';

/** Static retrieval topics, not inferred identities, compositions or provenance. */
export interface ConnectionTopicPlan {
  key: string;
  subjectId: string;
  claim: DiscoveryClaim;
  sourceCue: string;
  tagQuery: string;
  readonly tagQueries?: readonly string[];
  readonly sourceFeatureIds?: readonly string[];
  requiresDocumentary: boolean;
}

const ART = ['interior', 'place', 'media', 'other'];
/** Closed taxonomy: queries and public cues never interpolate untrusted source text. */
export const CONNECTION_TOPICS = [
  { key: 'tennis', tagQuery: 'tennis', sourceCue: 'tennis-related form', requiresDocumentary: false,
    categories: ['fashion', 'other', 'media'], source: /\btennis\b/i, focus: /\btennis\b/i },
  { key: 'sneaker_culture', tagQuery: 'sneaker culture', sourceCue: 'sneaker form', requiresDocumentary: true,
    categories: ['fashion'], source: /\b(?:sneakers?|trainers?|sneaker culture)\b/i, focus: /\b(?:sneakers?|sneakerheads?|sneaker culture)\b/i },
  { key: 'tailoring', tagQuery: 'tailoring', sourceCue: 'tailored garment form', requiresDocumentary: true,
    categories: ['fashion'], source: /\b(?:tailor(?:ed|ing)?|suits?|tuxedos?|blazers?)\b/i, focus: /\b(?:tailor(?:s|ing|ed)?|bespoke|suit making)\b/i },
  { key: 'skateboarding', tagQuery: 'skateboarding', sourceCue: 'skate-related style', requiresDocumentary: false,
    categories: ['fashion', 'other'], source: /\b(?:skateboarding|skateboards?|skatewear)\b/i, focus: /\b(?:skateboard(?:s|ers?|ing)?)\b/i },
  { key: 'fashion_design', tagQuery: 'fashion design', sourceCue: 'garment design', requiresDocumentary: true,
    categories: ['fashion'], source: /\b(?:garments?|jackets?|coats?|shirts?|sweatshirts?|hoodies?|tees?|tops?|dress(?:es)?|gowns?|trousers?|pants?|skirts?|fashion design)\b/i,
    focus: /\b(?:fashion designers?|fashion design|garment making|dressmaking|couture|clothing design)\b/i },
  { key: 'sculpture', tagQuery: 'sculpture', sourceCue: 'sculptural object form', requiresDocumentary: true,
    categories: ART, source: /\b(?:sculptures?|statues?|busts?|figurines?|effigies|effigy|(?:head|face) vessels?)\b/i,
    focus: /\b(?:sculptors?|sculptures?|sculpting)\b/i },
  { key: 'pottery', tagQuery: 'pottery', sourceCue: 'ceramic appearance', requiresDocumentary: true,
    categories: ['interior', 'place', 'media'], source: /\b(?:ceramics?|pottery|porcelain|stoneware|earthenware|terracotta)\b/i,
    focus: /\b(?:potters?|pottery|ceramics?|ceramicists?)\b/i },
  { key: 'furniture', tagQuery: 'furniture', sourceCue: 'furniture form', requiresDocumentary: true,
    categories: ['interior', 'place'], source: /\b(?:furniture|beds?|armchairs?|chairs?|dining sets?|sofas?|cabinets?|credenzas?|tables?)\b/i,
    focus: /\b(?:furniture|furniture designers?|furniture making)\b/i },
  { key: 'abandoned_buildings', tagQuery: 'abandoned buildings', sourceCue: 'abandoned-building appearance', requiresDocumentary: true,
    categories: ['interior', 'place'], source: /\b(?:abandoned|derelict|ruined|ruins)\b/i,
    focus: /\b(?:abandoned|derelict|ruined|ruins)\b[^.!?]{0,70}\b(?:buildings?|architecture|houses?|hotels?|motels?|cities|towns?|spaces?)\b/i },
  { key: 'noodles', tagQuery: 'noodles', sourceCue: 'noodle dish appearance', requiresDocumentary: true,
    categories: ['food'], source: /\b(?:ramen|noodles?|pasta)\b/i, focus: /\b(?:ramen|noodles?|pasta)\b/i },
  { key: 'coffee', tagQuery: 'coffee', sourceCue: 'coffee-related appearance', requiresDocumentary: true,
    categories: ['food'], source: /\b(?:coffee|espresso|cappuccino|latte|coffee making)\b/i,
    focus: /\b(?:coffee|espresso|baristas?)\b/i },
  { key: 'painting', tagQuery: 'painting', sourceCue: 'painted artwork appearance', requiresDocumentary: true,
    categories: ART, source: /\b(?:paintings?|portraits?|portraiture|illustrations?|oil on canvas)\b/i,
    focus: /\b(?:painters?|paintings?|portraiture)\b/i },
  { key: 'architecture', tagQuery: 'architecture', sourceCue: 'architectural space', requiresDocumentary: true,
    categories: ['interior', 'place'], source: /\b(?:architectur\w*|buildings?|palaces?|facades?|rooms?|sunrooms?|bedrooms?|kitchens?|dining nooks?|interiors?|houses?|urbanism|lofts?)\b/i,
    focus: /\b(?:architects?|architecture|architectural|urban planning|interior design)\b/i },
] as const;

/** Language equivalents / explicit practice siblings, never guessed provider ids. */
const TOPIC_QUERIES: Readonly<Record<string, readonly string[]>> = {
  tennis: ['tennis'], sneaker_culture: ['sneaker culture', 'sneakers'],
  tailoring: ['tailoring', 'bespoke tailoring'], skateboarding: ['skateboarding'],
  fashion_design: ['fashion design', 'garment making'], sculpture: ['sculpture', 'sculpting'],
  pottery: ['pottery', 'ceramics'], furniture: ['furniture', 'furniture design'],
  abandoned_buildings: ['abandoned buildings', 'abandoned architecture'],
  noodles: ['noodles', 'ramen'], coffee: ['coffee', 'coffee making'],
  painting: ['painting', 'portraiture'], architecture: ['architecture', 'interior design'],
};

/** Claims grounded only in context cannot open a content route. */
export function connectionSourceClaims(subject: StoredSubject): DiscoveryClaim[] {
  const observed = observationDiscoveryClaims(subject);
  return discoveryClaims(subject).filter((claim) => claim.slot === 'label' ||
    observed.some((c) => c.slot === claim.slot && c.name === claim.name && c.wording === claim.wording) ||
    (claim.slot === 'era' ? subject.era?.basis !== 'context' :
      subject[claim.slot].some((c) => c.name === claim.name && !c.held && !c.retracted && c.basis !== 'context')));
}

/** At most two topics, first giving distinct subjects a turn, then a second topic. */
export function planConnectionTopics(subjects: readonly StoredSubject[]): ConnectionTopicPlan[] {
  const perSubject = subjects.map((subject) => {
    const claims = connectionSourceClaims(subject);
    const plans: ConnectionTopicPlan[] = [];
    for (const topic of CONNECTION_TOPICS) {
      if (!(topic.categories as readonly string[]).includes(subject.category)) continue;
      // Unclassified art needs an explicit thing noun, not an aesthetic/material.
      const candidates = subject.category === 'other' ? claims.filter((c) => c.slot === 'label') : claims;
      const claim = [...candidates.filter((c) => c.slot === 'label'), ...candidates.filter((c) => c.slot !== 'label')]
        .find((c) => topic.source.test(c.name));
      if (!claim) continue;
      // Ceramic tiles in a room are not evidence of pottery practice.
      if (topic.key === 'pottery' && !/\b(?:bowls?|mugs?|cups?|jugs?|vases?|vessels?|pottery|sculptures?|figurines?|ceramic objects?)\b/i.test(subject.label)) continue;
      if (topic.key === 'abandoned_buildings' && !/\b(?:buildings?|rooms?|bedrooms?|houses?|motels?|hotels?|interiors?|ruins|architecture)\b/i.test(subject.label)) continue;
      // Specific object/practice beats the broad architecture/fashion umbrella.
      if (topic.key === 'fashion_design' && plans.length) continue;
      const features = compileSourceFeaturePlan([subject], 1).features;
      plans.push({ key: topic.key, subjectId: subject.id, claim, sourceCue: topic.sourceCue, tagQuery: topic.tagQuery,
        tagQueries: TOPIC_QUERIES[topic.key], sourceFeatureIds: features.filter((f) =>
          f.kind === 'object_form' || (f.claim.slot === claim.slot && f.claim.name === claim.name)).map((f) => f.id),
        requiresDocumentary: topic.requiresDocumentary });
    }
    return plans;
  });
  const result: ConnectionTopicPlan[] = [];
  for (const index of [0, 1])
    for (const plans of perSubject) {
      const plan = plans[index];
      if (plan && !result.some((p) => p.key === plan.key && p.subjectId === plan.subjectId)) result.push(plan);
      if (result.length === 2) return result;
    }
  return result;
}

/** Caller-supplied plans are constraints, not authority to fabricate a claim/query. */
export function activeConnectionTopicPlan(subject: StoredSubject, supplied: ConnectionTopicPlan): ConnectionTopicPlan | null {
  return planConnectionTopics([subject]).find((p) => p.subjectId === supplied.subjectId && p.key === supplied.key &&
    p.tagQuery === supplied.tagQuery && p.sourceCue === supplied.sourceCue && p.requiresDocumentary === supplied.requiresDocumentary &&
    (!supplied.tagQueries || JSON.stringify(p.tagQueries) === JSON.stringify(supplied.tagQueries)) &&
    (!supplied.sourceFeatureIds || JSON.stringify(p.sourceFeatureIds) === JSON.stringify(supplied.sourceFeatureIds)) &&
    p.claim.slot === supplied.claim.slot && p.claim.name === supplied.claim.name && p.claim.wording === supplied.claim.wording) ?? null;
}
