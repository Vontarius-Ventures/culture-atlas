import type { StyleBox, StyleCategory } from '@culture-atlas/providers';

/** Claim slots of a style subject (A.1). */
export type StyleSlot = 'aesthetics' | 'era' | 'lineage' | 'materials' | 'construction' | 'palette' | 'mood' | 'details';
export type Wording = 'asserted' | 'resembles';
export type Strength = 'clear' | 'likely' | 'possible';
export type CorroborationSource = 'stage1' | 'stage2' | 'qloo_entity';

/** How a claim maps to Qloo (C.2). Null on the claim when nothing was accepted (rule 8). */
export interface ClaimQloo {
  tag_ids: string[];
  /** Other exactly-matching ids (rule 5): used for reason overlap only. */
  alt_ids: string[];
  acceptance: 'vocab_exact' | 'alias' | 'tags_exact';
  namespace: string;
  /** filter: may be sent as filter.tags; signal: weighted signal; reason: reason overlap only (rule 4 / Q-DOUBT). */
  use: 'filter' | 'signal' | 'reason';
  weight: number;
  /** Entity types the tag is known to apply to (vocabulary seenOn or /v2/tags parents). */
  entity_types: string[];
  doubt?: boolean;
}

export interface StoredClaim {
  name: string;
  certainty: number;
  wording: Wording;
  display: string;
  strength: Strength | null;
  corroborated_by: CorroborationSource[];
  /** Kept back (guard hold) until stage 2 corroborates it; never shown while held. */
  held: boolean;
  hold_rule?: string;
  /** Removed after display by a stage-2 veto (B.4); clients fade it out. */
  retracted?: boolean;
  basis: 'visible' | 'read_text' | 'context';
  region: StyleBox | null;
  qloo: ClaimQloo | null;
  tag_query?: string | null;
}

export interface StoredAesthetic extends StoredClaim {
  defining_features: string[];
  resembles_only?: boolean;
}
export interface StoredEra extends StoredClaim {
  cue: string;
}
export interface StoredMaterial extends StoredClaim {
  texture: string;
}
export interface StoredConstruction extends StoredClaim {
  kind: string;
}
export interface StoredDetail extends StoredClaim {
  text: string;
}
export interface StoredPalette {
  swatch: number;
  name: string;
  hex: string;
  display: string;
  wording: 'asserted';
}

export interface StoredSubject {
  id: string;
  category: StyleCategory;
  label: string;
  region: StyleBox;
  aesthetics: StoredAesthetic[];
  era: StoredEra | null;
  lineage: StoredClaim[];
  materials: StoredMaterial[];
  construction: StoredConstruction[];
  palette: StoredPalette[];
  mood: StoredClaim[];
  details: StoredDetail[];
  brand: { name: string; read_text: string } | null;
  /** Qloo's own similar_brand tag names of the subject's identified brand (C.3 brand bonus); text only. */
  qloo_links: string[];
  /** The subject's identified Qloo entity (anchor), when one overlaps it (C.1). */
  entity: { id: string; name: string; types: string[] } | null;
}

/** analyses.style_reading (A.7). */
export interface StoredStyleReading {
  schema: 'atlas_style_reading_v1';
  wording_version: string;
  guard_version: string;
  vocab_version: string;
  /** Revision of this reading (R-6): rails record the revision they were built from. */
  rev: number;
  model: { role: 'vision_style'; profile: string | null; model: string; experimental: boolean; ms: number };
  image: { width: number; height: number; frame_index: number | null };
  swatches: { index: number; hex: string; share: number }[];
  summary: string;
  subjects: StoredSubject[];
  dropped: { path: string; rule: string }[];
  held: { path: string; rule: string }[];
  retracted: string[];
}
