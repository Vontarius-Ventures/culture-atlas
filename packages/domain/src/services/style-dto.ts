import { CATEGORIES, type Category } from '../enums';
import type { DiscoveryCard } from '../schemas/common';
import { STYLE_COPY, type MediaStylePreview, type RailDto, type RailStatus, type StyleReadingDto, type StyleSubjectDto } from '../schemas/style';
import type { StoredStyleReading, StoredSubject } from '../style/types';
import { safeSubjectLabel } from '../style/source-feature-plan';

/**
 * Stored style reading -> wire DTO (style design §E.2). Held and retracted
 * claims are never sent (retracted claim paths are listed for the fade);
 * certainty never leaves the server; claim regions only with
 * STYLE_SHOW_CLAIM_REGIONS (R-15). Display strings are the server's.
 */
export function styleReadingDto(stored: StoredStyleReading, options: { showClaimRegions: boolean; safeSubjectLabels?: boolean }): StyleReadingDto {
  const shown = <T extends { held: boolean; retracted?: boolean }>(xs: readonly T[]) => xs.filter((x) => !x.held && !x.retracted);
  const region = (r: { x: number; y: number; w: number; h: number } | null) => (options.showClaimRegions ? r : null);
  return {
    version: 'atlas_style_reading_v1',
    summary: options.safeSubjectLabels ? stored.subjects.map(safeSubjectLabel).join('; ') : stored.summary,
    swatches: stored.swatches.map((s) => ({ index: s.index, hex: s.hex, share: s.share })),
    subjects: stored.subjects.map(
      (s): StyleSubjectDto => ({
        id: s.id as 's1' | 's2',
        category: s.category,
        label: options.safeSubjectLabels ? safeSubjectLabel(s) : s.label,
        region: s.region,
        aesthetics: shown(s.aesthetics).map((a) => ({
          name: a.name,
          wording: a.wording,
          display: a.display,
          strength: a.strength ?? (a.wording === 'asserted' ? 'likely' : 'possible'),
          region: region(a.region),
          features: a.defining_features,
        })),
        era: s.era && !s.era.held && !s.era.retracted ? { name: s.era.name, display: s.era.display, wording: s.era.wording } : null,
        lineage: shown(s.lineage).map((l) => ({ name: l.name, display: l.display, wording: l.wording })),
        materials: shown(s.materials).map((m) => ({ name: m.name, texture: m.texture, wording: m.wording, display: m.display, strength: m.strength, region: region(m.region) })),
        construction: shown(s.construction).map((c) => ({ name: c.name, kind: c.kind, wording: c.wording, display: c.display, strength: c.strength, region: region(c.region) })),
        palette: s.palette.map((p) => ({ swatch: p.swatch, name: p.name, hex: p.hex, display: p.display })),
        mood: shown(s.mood).map((m) => ({ name: m.name, display: m.display })),
        details: shown(s.details).map((d) => ({ text: d.text, display: d.display, wording: d.wording, strength: d.strength, region: region(d.region) })),
        brand: s.brand,
        qloo_links: s.qloo_links,
        rail: `more_like_this:${s.id}`,
      }),
    ),
    retracted: stored.retracted,
  };
}

/** Section status -> rail status (R-16c): old statuses map to the new terminal set. */
export function railStatusOf(status: string | undefined): RailStatus {
  switch (status) {
    case 'pending':
    case 'running':
    case 'ready':
    case 'empty':
    case 'failed':
    case 'held':
      return status;
    case 'complete':
    case 'partial':
      return 'ready';
    case 'skipped':
      return 'empty';
    case 'unavailable':
      return 'failed';
    default:
      return 'pending';
  }
}

/** The attributes that drove a subject's rail: its Qloo-mapped aesthetics and materials, as shown. */
export function railSubtitle(subject: StoredSubject): string | null {
  const names = [...subject.aesthetics, ...subject.materials].filter((c) => c.qloo && !c.held && !c.retracted).map((c) => c.name);
  const unique = [...new Set(names)].slice(0, 2);
  return unique.length ? unique.join(' · ') : subject.entity?.name ?? null;
}

export interface RailInput {
  stored: StoredStyleReading | null;
  sections: Record<string, string>;
  /** Cards per More-like-this subject, in rank order (hidden cards already removed). */
  moreLikeThis: ReadonlyMap<string, DiscoveryCard[]>;
  /** Cross-domain cards by category, in rank order. */
  crossDomain: ReadonlyMap<Category, DiscoveryCard[]>;
  experimental: boolean;
  /** New Connections contract: labels are not provenance, and empty ready rails are terminal empty. */
  validatedConnections?: boolean;
}

const TITLES: Record<Category, string> = { wear: 'Wear', play: 'Play', watch: 'Watch', eat: 'Eat' };

/** Describe the entities, not an unverified visual relationship or taste affinity. */
export function subjectRailTitle(subject: StoredSubject | null, cards: readonly DiscoveryCard[]): string {
  if (!cards.length) return 'Qloo connections';
  if (cards.every((c) => c.kind === 'brand')) {
    if (subject?.category === 'interior') return 'Home brands to explore';
    if (subject?.category === 'food') return 'Food & drink brands to explore';
    return 'Brands to explore';
  }
  if (cards.every((c) => c.kind === 'film')) return 'Films to explore';
  // An artist kind alone does not establish a musician.
  if (cards.every((c) => (c.kind === 'artist' || c.kind === 'track') && c.category === 'play')) return 'Music to explore';
  if (cards.every((c) => c.kind === 'food')) return 'Food & places to explore';
  return 'Qloo connections';
}

function railEmptyCopy(reason: string | undefined): string {
  if (reason === 'no_city') return STYLE_COPY.style.no_city;
  if (reason === 'unsupported') return STYLE_COPY.style.unsupported;
  return STYLE_COPY.style.rail_empty;
}

/** rails[] for GET /v1/captures/{id} (E.2), in display order. */
export function buildRails(input: RailInput): RailDto[] {
  const rails: RailDto[] = [];
  const subjectIds = new Set<string>([...(input.stored?.subjects.map((s) => s.id) ?? []), ...input.moreLikeThis.keys()]);
  for (const id of [...subjectIds].sort()) {
    const key = `more_like_this:${id}`;
    const subject = input.stored?.subjects.find((s) => s.id === id) ?? null;
    const cards = input.moreLikeThis.get(id) ?? [];
    let status = railStatusOf(input.sections[key]);
    if (input.validatedConnections && !cards.length && status === 'ready') status = 'empty';
    if (cards.length && status !== 'running') status = 'ready';
    if (!input.sections[key] && !cards.length) status = input.sections.style === 'ready' ? 'running' : railStatusOf(input.sections.style);
    const reason = input.sections[`${key}:reason`];
    rails.push({
      key,
      kind: 'more_like_this',
      title: subjectRailTitle(subject, cards),
      subtitle: subject ? (input.validatedConnections ? safeSubjectLabel(subject) : railSubtitle(subject)) : null,
      subject_id: id,
      status,
      empty_message: status === 'empty' ? railEmptyCopy(reason) : null,
      caption: null,
      cards,
    });
  }
  const firstMlt = rails.findIndex((r) => r.cards.length > 0 || r.status === 'running');
  if (input.experimental && firstMlt >= 0) rails[firstMlt]!.caption = STYLE_COPY.experimental.rail_caption;
  const order = [...CATEGORIES].sort((a, b) => {
    const ca = input.crossDomain.get(a)?.length ? 0 : 1;
    const cb = input.crossDomain.get(b)?.length ? 0 : 1;
    return ca - cb || CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b);
  });
  let captioned = false;
  for (const c of order) {
    const cards = input.crossDomain.get(c) ?? [];
    let status = cards.length ? 'ready' : railStatusOf(input.sections[c]);
    if (input.validatedConnections && !cards.length && status === 'ready') status = 'empty';
    const caption = input.experimental && !captioned && cards.length ? STYLE_COPY.experimental.rail_caption : null;
    if (caption) captioned = true;
    rails.push({ key: c, kind: 'cross_domain', title: TITLES[c], subtitle: null, subject_id: null, status, empty_message: status === 'empty' ? railEmptyCopy(input.sections[`${c}:reason`]) : null, caption, cards });
  }
  return rails;
}

/** E.3: the compact preview the v2 media analysis result carries. */
export function mediaStylePreview(stored: StoredStyleReading | null, styleSection: string | undefined, options: { safeSubjectLabels?: boolean } = {}): MediaStylePreview | null {
  const status = railStatusOf(styleSection);
  if (!stored) return status === 'pending' ? null : { status, summary: null, aesthetics: [], swatches: [], frame_index: null };
  return {
    status: 'ready',
    summary: options.safeSubjectLabels ? stored.subjects.map(safeSubjectLabel).join('; ') : stored.summary,
    aesthetics: stored.subjects
      .flatMap((s) => s.aesthetics.filter((a) => !a.held && !a.retracted).map((a) => ({ subject_id: s.id, display: a.display, wording: a.wording })))
      .slice(0, 4),
    swatches: stored.swatches.map((s) => s.hex),
    frame_index: stored.image.frame_index,
  };
}
