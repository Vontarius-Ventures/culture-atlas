import type { GuardedStyleSubject, StyleSubject } from '@culture-atlas/providers';
import type { StoredSubject } from './types';

/** Test builders for style subjects (never model output: shapes only). */
export function guardedSubject(over: Partial<GuardedStyleSubject> = {}): GuardedStyleSubject {
  return {
    id: 's1',
    category: 'fashion',
    label: 'Canvas work jacket',
    region: { x: 0.1, y: 0.1, w: 0.6, h: 0.8 },
    aesthetics: [],
    era: null,
    lineage: [],
    materials: [],
    construction: [],
    palette: [],
    mood: [],
    details: [],
    brand: null,
    ...over,
  };
}

export function aesthetic(name: string, certainty: number, over: Partial<GuardedStyleSubject['aesthetics'][number]> = {}): GuardedStyleSubject['aesthetics'][number] {
  return { name, certainty, defining_features: ['duck canvas shell', 'corduroy collar'], evidence: { basis: 'visible', region: null }, tag_query: null, ...over };
}

export function modelSubject(over: Partial<StyleSubject> = {}): StyleSubject {
  return guardedSubject(over as Partial<GuardedStyleSubject>) as StyleSubject;
}

export function storedSubject(over: Partial<StoredSubject> = {}): StoredSubject {
  return {
    id: 's1',
    category: 'fashion',
    label: 'Canvas work jacket',
    region: { x: 0.1, y: 0.1, w: 0.6, h: 0.8 },
    aesthetics: [],
    era: null,
    lineage: [],
    materials: [],
    construction: [],
    palette: [],
    mood: [],
    details: [],
    brand: null,
    qloo_links: [],
    entity: null,
    ...over,
  };
}

export function storedAesthetic(name: string, over: Partial<StoredSubject['aesthetics'][number]> = {}): StoredSubject['aesthetics'][number] {
  return {
    name,
    certainty: 0.9,
    wording: 'asserted',
    display: name,
    strength: 'clear',
    corroborated_by: [],
    held: false,
    basis: 'visible',
    region: null,
    qloo: null,
    defining_features: ['a', 'b'],
    tag_query: null,
    ...over,
  };
}
