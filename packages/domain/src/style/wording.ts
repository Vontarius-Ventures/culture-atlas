import { lowerFirst } from './text';
import type { GuardedStyleSubject, StyleSwatch } from '@culture-atlas/providers';
import { normalizeStyleName } from './vocabulary';
import type {
  CorroborationSource,
  StoredAesthetic,
  StoredClaim,
  StoredConstruction,
  StoredDetail,
  StoredEra,
  StoredMaterial,
  StoredPalette,
  StoredSubject,
  Strength,
  Wording,
} from './types';

/**
 * Server-decided wording (style design §A.2, amended R-8 and R-16a). The model
 * reports certainty and evidence only; these rules decide asserted vs
 * "resembles" and drop the rest. Versioned: changing a bar bumps sw-N.
 * The sw-1 bars are the design's starting values; R-8 fits them on the
 * style-v1 tune split before holdout (docs/style-eval.md).
 */
export const STYLE_WORDING_VERSION = 'sw-1';

export const WORDING = {
  aesthetic: { assert: 0.85, assertCorroborated: 0.75, assertSameFamily: 0.8, floor: 0.4, minFeatures: 2 },
  eraLineage: { floor: 0.45 },
  material: { assert: 0.7, floor: 0.4 },
  constructionDetail: { assert: 0.65, floor: 0.4 },
  mood: { floor: 0.5 },
} as const;

/** Coarse public band (E.2): derived after wording, so asserted is clear|likely and resembles is likely|possible. */
export function strengthFor(wording: Wording, certainty: number): Strength {
  if (wording === 'asserted') return certainty >= 0.75 ? 'clear' : 'likely';
  return certainty >= 0.55 ? 'likely' : 'possible';
}

const upperFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** "Mid-century modern" -> "mid-century modern"; acronyms ("UK", "NYC") keep their case. */

/** Display copy (A.2): clients render these strings verbatim. */
export const DISPLAY = {
  asserted: (name: string) => upperFirst(name),
  resembles: (name: string) => `Resembles ${lowerFirst(name)}`,
  looksLike: (name: string) => `Looks like ${lowerFirst(name)}`,
  era: (name: string) => `Suggests ${/^\d/.test(name) ? 'the ' : ''}${lowerFirst(name)}`,
  mood: (name: string) => `Feels ${name.toLowerCase()}`,
} as const;

export interface CorroborationEvidence {
  /** Normalized names / tag queries of guarded stage-1 style or tradition candidates. */
  stage1: ReadonlySet<string>;
  /** Normalized names of stage-2 additions (style or tradition) that passed its guard. */
  stage2: ReadonlySet<string>;
  /** Normalized names of accepted Qloo tags of resolved anchors (e.g. the identified brand's personal_style). */
  qlooEntity: ReadonlySet<string>;
  /** Stage 1/2 ran on the same model family as the style reading (R-8: their corroboration lowers the bar only to 0.80). */
  sameFamily: boolean;
  /** Normalized names stage 2 explicitly rejected (veto: the claim is dropped or retracted). */
  vetoed?: ReadonlySet<string>;
}

export const NO_CORROBORATION: CorroborationEvidence = { stage1: new Set(), stage2: new Set(), qlooEntity: new Set(), sameFamily: true };

/** A.6: which sources corroborate a claim (normalized name or tag query). */
export function corroboratedBy(name: string, tagQuery: string | null | undefined, ev: CorroborationEvidence): CorroborationSource[] {
  const keys = [normalizeStyleName(name), tagQuery ? normalizeStyleName(tagQuery) : ''].filter(Boolean);
  const out: CorroborationSource[] = [];
  if (keys.some((k) => ev.stage1.has(k))) out.push('stage1');
  if (keys.some((k) => ev.stage2.has(k))) out.push('stage2');
  if (keys.some((k) => ev.qlooEntity.has(k))) out.push('qloo_entity');
  return out;
}

/** A.2 aesthetics row (with R-8 / R-19 corroboration bars). Null = dropped. */
export function aestheticWording(
  a: { certainty: number; basis: string; features: number; resemblesOnly?: boolean },
  corroboration: readonly CorroborationSource[],
  sameFamily: boolean,
): Wording | null {
  const w = WORDING.aesthetic;
  if (a.certainty < w.floor) return null;
  if (a.resemblesOnly || a.basis !== 'visible' || a.features < w.minFeatures) return 'resembles';
  // R-19: Qloo-entity corroboration counts only with >= 2 visible features (checked above).
  const bar = corroboration.includes('qloo_entity')
    ? w.assertCorroborated
    : corroboration.length
      ? sameFamily
        ? w.assertSameFamily
        : w.assertCorroborated
      : w.assert;
  return a.certainty >= bar ? 'asserted' : 'resembles';
}

export function eraLineageWording(c: { certainty: number; basis: string }): Wording | null {
  if (c.basis === 'read_text') return 'asserted';
  return c.certainty >= WORDING.eraLineage.floor ? 'resembles' : null;
}

export function materialWording(c: { certainty: number; basis: string }): Wording | null {
  if (c.certainty < WORDING.material.floor) return null;
  return c.certainty >= WORDING.material.assert && c.basis === 'visible' ? 'asserted' : 'resembles';
}

export function constructionWording(c: { certainty: number; basis: string }): Wording | null {
  if (c.certainty < WORDING.constructionDetail.floor) return null;
  return c.certainty >= WORDING.constructionDetail.assert && c.basis === 'visible' ? 'asserted' : 'resembles';
}

/** Mood is never asserted; it reads "Feels …". */
export function moodWording(c: { certainty: number }): 'resembles' | null {
  return c.certainty >= WORDING.mood.floor ? 'resembles' : null;
}

export interface WordSubjectInput {
  subject: GuardedStyleSubject;
  swatches: readonly StyleSwatch[];
  /** G-STYLE-PALETTE: swatch indexes measured inside the subject's region. */
  presentSwatches: ReadonlySet<number>;
  corroboration: CorroborationEvidence;
  /** R-15: claim regions are sent only once M-G passes (STYLE_SHOW_CLAIM_REGIONS). */
  keepClaimRegions: boolean;
}

/**
 * Words one guarded subject into its stored form (A.7). Claims below their
 * floors are dropped (G-LOWCERT), vetoed names are dropped, held claims stay
 * stored with held=true. Qloo mapping is filled later (map-tags.ts).
 */
export function wordSubject(input: WordSubjectInput, dropped: { path: string; rule: string }[]): StoredSubject {
  const { subject: s, corroboration: ev } = input;
  const sp = `subjects[${s.id}]`;
  const vetoed = (name: string) => !!ev.vetoed?.has(normalizeStyleName(name));
  const base = (name: string, certainty: number, wording: Wording, display: string, basis: StoredClaim['basis'], strength: Strength | null, cb: CorroborationSource[], hold?: string): StoredClaim => ({
    name,
    certainty,
    wording,
    display,
    strength,
    corroborated_by: cb,
    held: !!hold,
    ...(hold ? { hold_rule: hold } : {}),
    basis,
    region: null,
    qloo: null,
  });
  const aesthetics: StoredAesthetic[] = [];
  s.aesthetics.forEach((a, i) => {
    const cb = corroboratedBy(a.name, a.tag_query, ev);
    if (vetoed(a.name)) return void dropped.push({ path: `${sp}.aesthetics[${i}]`, rule: 'G-VETO' });
    const wording = aestheticWording({ certainty: a.certainty, basis: a.evidence.basis, features: a.defining_features.length, resemblesOnly: a.resembles_only }, cb, ev.sameFamily);
    if (!wording) return void dropped.push({ path: `${sp}.aesthetics[${i}]`, rule: 'G-LOWCERT' });
    // A held claim is released only by corroboration from stage 2 or a Qloo entity.
    const hold = a.held && !(cb.includes('stage2') || (cb.includes('qloo_entity') && a.defining_features.length >= 2)) ? a.held : undefined;
    aesthetics.push({
      ...base(a.name, a.certainty, wording, wording === 'asserted' ? DISPLAY.asserted(a.name) : DISPLAY.resembles(a.name), a.evidence.basis, strengthFor(wording, a.certainty), cb, hold),
      region: input.keepClaimRegions ? a.evidence.region : null,
      defining_features: a.defining_features,
      tag_query: a.tag_query,
      ...(a.resembles_only ? { resembles_only: true } : {}),
    });
  });
  let era: StoredEra | null = null;
  if (s.era) {
    const w = vetoed(s.era.name) ? null : eraLineageWording(s.era);
    if (!w) dropped.push({ path: `${sp}.era`, rule: 'G-LOWCERT' });
    else {
      const cb = corroboratedBy(s.era.name, null, ev);
      era = { ...base(s.era.name, s.era.certainty, w, DISPLAY.era(s.era.name), s.era.basis, null, cb, s.era.held && !cb.includes('stage2') ? s.era.held : undefined), cue: s.era.cue };
    }
  }
  const lineage: StoredClaim[] = [];
  s.lineage.forEach((l, i) => {
    const w = vetoed(l.name) ? null : eraLineageWording(l);
    if (!w) return void dropped.push({ path: `${sp}.lineage[${i}]`, rule: 'G-LOWCERT' });
    const cb = corroboratedBy(l.name, null, ev);
    lineage.push(base(l.name, l.certainty, w, w === 'asserted' ? DISPLAY.asserted(l.name) : DISPLAY.resembles(l.name), l.basis, null, cb, l.held && !cb.includes('stage2') ? l.held : undefined));
  });
  const materials: StoredMaterial[] = [];
  s.materials.forEach((m, i) => {
    const w = materialWording(m);
    if (!w) return void dropped.push({ path: `${sp}.materials[${i}]`, rule: 'G-LOWCERT' });
    materials.push({ ...base(m.name, m.certainty, w, w === 'asserted' ? DISPLAY.asserted(m.name) : DISPLAY.looksLike(m.name), m.basis, strengthFor(w, m.certainty), corroboratedBy(m.name, m.tag_query, ev)), texture: m.texture, tag_query: m.tag_query });
  });
  const construction: StoredConstruction[] = [];
  s.construction.forEach((c, i) => {
    const w = constructionWording(c);
    if (!w) return void dropped.push({ path: `${sp}.construction[${i}]`, rule: 'G-LOWCERT' });
    construction.push({ ...base(c.name, c.certainty, w, w === 'asserted' ? DISPLAY.asserted(c.name) : DISPLAY.looksLike(c.name), c.basis, strengthFor(w, c.certainty), []), kind: c.kind });
  });
  const details: StoredDetail[] = [];
  s.details.forEach((d, i) => {
    const w = constructionWording({ certainty: d.certainty, basis: d.evidence.basis });
    if (!w) return void dropped.push({ path: `${sp}.details[${i}]`, rule: 'G-LOWCERT' });
    details.push({
      ...base(d.text, d.certainty, w, w === 'asserted' ? DISPLAY.asserted(d.text) : DISPLAY.looksLike(d.text), d.evidence.basis, strengthFor(w, d.certainty), []),
      region: input.keepClaimRegions ? d.evidence.region : null,
      text: d.text,
    });
  });
  const mood: StoredClaim[] = [];
  s.mood.forEach((m, i) => {
    const w = moodWording(m);
    if (!w) return void dropped.push({ path: `${sp}.mood[${i}]`, rule: 'G-LOWCERT' });
    mood.push(base(m.name, m.certainty, w, DISPLAY.mood(m.name), 'visible', null, []));
  });
  const palette: StoredPalette[] = [];
  s.palette.forEach((p, i) => {
    const sw = input.swatches.find((x) => x.index === p.swatch);
    if (!sw || !input.presentSwatches.has(p.swatch)) return void dropped.push({ path: `${sp}.palette[${i}]`, rule: 'G-STYLE-PALETTE' });
    palette.push({ swatch: p.swatch, name: p.name, hex: sw.hex, display: upperFirst(p.name), wording: 'asserted' });
  });
  return {
    id: s.id,
    category: s.category,
    label: s.label,
    region: s.region,
    aesthetics,
    era,
    lineage,
    materials,
    construction,
    palette,
    mood,
    details,
    brand: s.brand,
    qloo_links: [],
    entity: null,
  };
}

/**
 * Re-words a stored subject after the stage-2 corroboration pass (B.4):
 * wording only moves up (resembles -> asserted), held claims may be
 * released, and a vetoed claim is marked retracted (never silently removed).
 * Returns the paths that changed.
 */
export function rewordAfterStage2(subject: StoredSubject, ev: CorroborationEvidence): { upgraded: string[]; released: string[]; retracted: string[] } {
  const upgraded: string[] = [];
  const released: string[] = [];
  const retracted: string[] = [];
  const sp = `subjects[${subject.id}]`;
  subject.aesthetics.forEach((a, i) => {
    const path = `${sp}.aesthetics[${i}]`;
    if (ev.vetoed?.has(normalizeStyleName(a.name)) && !a.retracted) {
      a.retracted = true;
      retracted.push(path);
      return;
    }
    const cb = [...new Set([...a.corroborated_by, ...corroboratedBy(a.name, a.tag_query, ev)])];
    a.corroborated_by = cb;
    if (a.held && (cb.includes('stage2') || (cb.includes('qloo_entity') && a.defining_features.length >= 2))) {
      a.held = false;
      delete a.hold_rule;
      released.push(path);
    }
    const w = aestheticWording({ certainty: a.certainty, basis: a.basis, features: a.defining_features.length, resemblesOnly: a.resembles_only }, cb, ev.sameFamily);
    if (a.wording === 'resembles' && w === 'asserted') {
      a.wording = 'asserted';
      a.display = DISPLAY.asserted(a.name);
      a.strength = strengthFor('asserted', a.certainty);
      upgraded.push(path);
    }
  });
  return { upgraded, released, retracted };
}
