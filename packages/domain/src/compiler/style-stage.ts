import sharp from 'sharp';
import {
  STYLE_GUARD_VERSION,
  STYLE_TIMEOUT_MS,
  guardStyleReading,
  isProviderError,
  NEUTRAL_PEOPLE_TITLE,
  styleTextAboutPerson,
  isUsable,
  type CallOptions,
  type QlooEntity,
  type QlooInsightsRequest,
  type QlooTag,
  type QlooTagRef,
  type StyleSwatch,
  type VlmStyleReading,
} from '@culture-atlas/providers';
import type { Category, ItemKind, SectionStatus } from '../enums';
import { LIMITS } from '../enums';
import { activeKills } from '../flags/feature-flags';
import type { JobContext } from '../jobs/handler';
import type { Owner } from '../principal';
import { destinationFromQlooProperties, imageFromQlooProperties } from '../services/display';
import { selectExemplars } from '../style/exemplars';
import { acceptedTags, bestFilterTag, mapSubjectTags, primaryStyleTag, tagLookupQueries, type AcceptedTag } from '../style/map-tags';
import { computeSwatches, PALETTE_SIZE, swatchIsBackground, swatchPresentInRegion, type Swatch } from '../style/palette';
import { buildStyleReason, sharedClaims, type StyleMatch, type StyleMatchClaim } from '../style/reasons';
import { affinityReason, entityProfile, genreFilterFor, rankCatalogue, scoreMatch, subjectProfile } from '../style/affinity';
import { lowerFirst } from '../style/text';
import { matchClaims, rankAffinity, type AffinityCandidate } from '../style/affinity-rail';
import type { StoredStyleReading, StoredSubject } from '../style/types';
import { closedTagQuery, closedVocabularyLists, normalizeStyleName, styleVocabulary, VOCAB_VERSION } from '../style/vocabulary';
import { NO_CORROBORATION, STYLE_WORDING_VERSION, rewordAfterStage2, wordSubject, type CorroborationEvidence } from '../style/wording';
import type { JobBudget } from './budget';
import { attemptCounter, errorSummary, recordProviderQuery } from './provider-queries';
import { FASHION_BRAND_TAG } from './grounding';
import {
  SECONDARY_BELOW,
  TAG_ONLY_TIMEOUT_MS,
  flatVerdict,
  fuseRail,
  outsideCity,
  planMoreLikeThis,
  qlooLinks,
  selectRail,
  type RailCandidate,
  type RailPlan,
} from './style-rails';
import { insertRecommendation, publishForCapture, setAnalysisSection, upsertDiscoveryItem, type CaptureForCompile } from './store';

/**
 * The style stage (prp/2026-10-23-style-analysis §B): a parallel stage that
 * reads the style of the photo (vision_style), guards and words it, maps it
 * to Qloo tags and builds the "More like this" rails. It never blocks the
 * stage-1 chips and never invents a result: every card is a real Qloo id,
 * every reason a real tag overlap, every hex a measured pixel.
 *
 * The host (CaptureCompiler, or the style_retry job) provides the job
 * context, the shared Qloo budget and the publish fence.
 */

type StyleJobContext = Pick<JobContext, 'db' | 'providers' | 'config' | 'signal' | 'trace' | 'runStage' | 'ensureActive' | 'job'>;

export interface StyleHost {
  readonly ctx: StyleJobContext;
  readonly analysisId: string;
  readonly capture: CaptureForCompile;
  readonly owner: Owner;
  readonly traceId: string | null;
  readonly budget: JobBudget;
  readonly startedAt: number;
  qlooCall<T>(stage: string, fn: (options: CallOptions) => Promise<T>): Promise<{ value: T; attempts: number }>;
  callOptions(stage: string): CallOptions;
  pastSoftDeadline(): boolean;
  /** Canonical keys already shown in this analysis (shared with cross-domain composition). */
  readonly usedKeys: Set<string>;
  readonly excludedKeys: () => Promise<Set<string>>;
  /** Video: the display frame's index in the media analysis (null for photos). */
  readonly frameIndex?: number | null;
  /** v2 photos: the style call the media worker already made (or is making), or null to call now. */
  readonly preread?: () => Promise<StyleCallOutput | null>;
}

/** What the stage-1 guarded reading says, for the style guard (R-7e) and corroboration (A.6). */
export interface Stage1Facts {
  usable: boolean;
  peopleShown: boolean;
  visibleText: string[];
  /** Normalized names and tag queries of published stage-1 style/tradition candidates. */
  styleNames: string[];
  /** Names of published stage-1 brand candidates (guard-v18: a logo stage 1 identified keeps the reading's brand). */
  brands?: string[];
}

export interface StyleAnchor {
  referenceId: string;
  name: string;
  entityId: string;
  types: string[];
  boxes: { x: number; y: number; w: number; h: number }[];
  tags: QlooTagRef[];
}

export interface StyleBridge {
  entityId: string;
  name: string;
  subjectId: string;
  /** The aesthetic the subject's rail was built on (reason text "from your {aesthetic} rail"). */
  aesthetic: string | null;
}

export type StyleSectionStatus = Extract<SectionStatus, 'ready' | 'empty' | 'failed' | 'held'>;

export interface StylePlan {
  enabled: boolean;
  /** Why it does not run: section status and reason. */
  off?: { status: StyleSectionStatus; reason: string };
}

export interface StyleCallOutput {
  reading: VlmStyleReading | null;
  model: string | null;
  ms: number;
  image: { width: number; height: number } | null;
  errorCode: string | null;
  experimental: boolean;
  profile: string | null;
}

/** 64x64 RGBA downsample of the capture image (palette and G-STYLE-PALETTE presence). */
export async function stylePixels(bytes: Uint8Array): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(bytes, { limitInputPixels: 100_000_000 })
    .rotate()
    .resize(PALETTE_SIZE, PALETTE_SIZE, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** The swatches sent to the model, from the same deterministic measurement the compile job repeats. */
export function publicSwatches(swatches: readonly Swatch[]): StyleSwatch[] {
  return swatches.map((s) => ({ index: s.index, hex: s.hex, share: Math.round(s.share * 1000) / 1000 }));
}

/**
 * v2 photos (§B.1 "started at t0"): the media worker starts the style call
 * next to its stage-1 call, on the same normalized derivative the capture
 * displays, and stores the raw reading on the media analysis request. The
 * compile job then reuses it (no second call, no second charge); the guard,
 * wording and rails still run in the compile job. Never throws for a
 * provider failure.
 */
export async function prereadStyle(
  providers: Pick<JobContext['providers'], 'vlmStyle' | 'modelGateway'>,
  bytes: Uint8Array,
  options: CallOptions,
): Promise<StyleCallOutput> {
  const gateway = providers.modelGateway;
  const experimental = !!gateway?.experimentalRoles.has('vision_style');
  const profile = gateway?.runners.vision_style?.profile.version ?? null;
  const started = Date.now();
  try {
    const px = await stylePixels(bytes);
    const swatches = publicSwatches(computeSwatches(px.data, px.width, px.height, px.channels));
    const res = await providers.vlmStyle.readStyle(
      { image: { bytes, mediaType: 'image/jpeg' }, swatches, vocabulary: closedVocabularyLists() },
      { ...options, maxRetries: 1, timeoutMs: STYLE_TIMEOUT_MS },
    );
    return { reading: res.reading, model: res.model, ms: Date.now() - started, image: res.image, errorCode: null, experimental, profile };
  } catch (err) {
    return { reading: null, model: null, ms: Date.now() - started, image: null, errorCode: errorSummary(err).code, experimental, profile };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  settled: boolean;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const d: Deferred<T> = {
    promise: new Promise<T>((r) => (resolve = r)),
    resolve: (v) => {
      if (d.settled) return;
      d.settled = true;
      resolve(v);
    },
    settled: false,
  };
  return d;
}


/** Wait up to `ms` for a promise; null on timeout. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => (t = setTimeout(() => r(null), Math.max(0, ms))));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Share of box a's area that lies inside box b. */
export function insideShare(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = a.w * a.h;
  return area > 0 ? inter / area : 0;
}

/** Rail card item kind and category from the result's entity type. */
function kindFor(types: readonly string[]): { kind: ItemKind; category: Category } | null {
  if (types.includes('urn:entity:brand')) return { kind: 'brand', category: 'wear' };
  if (types.includes('urn:entity:movie') || types.includes('urn:entity:tv_show')) return { kind: 'film', category: 'watch' };
  if (types.includes('urn:entity:artist')) return { kind: 'artist', category: 'play' };
  if (types.includes('urn:entity:place') || types.includes('urn:entity:destination')) return { kind: 'food', category: 'eat' };
  return null;
}

const PROVIDER_CACHE_TTL_SECONDS = 24 * 3600;

/** Qloo sometimes lists one brand twice ("Ikrush", "Ikrush."): keep the first by normalized name. */
export function dedupeByName<T extends { entity: { name: string } }>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = normalizeStyleName(c.entity.name).replace(/\s+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/** TOPIC-1: Qloo theme tags on films per subject category (recorded: fixtures/qloo/probe-2026-10-24-tune). */
export interface StyleTopic {
  tagId: string;
  topic: string;
}
const DESIGN: StyleTopic = { tagId: 'urn:tag:theme:qloo:design', topic: 'design' };
const ARCHITECTURE: StyleTopic = { tagId: 'urn:tag:theme:qloo:architecture', topic: 'architecture' };
const FOOD: StyleTopic = { tagId: 'urn:tag:theme:qloo:food', topic: 'food' };
/** Several filter tags are OR in Qloo (probe v1: design + architecture gave 20 films, design alone 4). */
export const TOPIC_BY_CATEGORY: Partial<Record<StoredSubject['category'], readonly StyleTopic[]>> = {
  interior: [DESIGN, ARCHITECTURE],
  place: [ARCHITECTURE, DESIGN],
  food: [FOOD],
};
/** TOPIC-1 films are ranked mostly by the reading (their tags: "Midcentury modern", "Decay", "Sushi"), then Qloo's order. */
export const TOPIC_STYLE_SHARE = 0.75;
/** ... and a film is kept only with a real overlap: at least this score, and this share of the best film's. */
export const TOPIC_MIN_SCORE = 0.6;
export const TOPIC_MIN_RELATIVE = 0.45;

/** TOPIC-1 card reason: the film's own Qloo theme (the first topic tag it carries) next to the subject's label. */
export function topicReason(topics: readonly StyleTopic[], filmTagIds: readonly string[], label: string): string {
  const topic = (topics.find((t) => filmTagIds.includes(t.tagId)) ?? topics[0]!).topic;
  const text = `A film about ${topic}, for the ${lowerFirst(label)} in your photo`;
  return text.length <= 90 ? text : `A film about ${topic}, like your photo`;
}

/** smatch-1: catalogue brands Qloo is asked to rank for a fashion subject, signals of the taste call, and its size. */
export const FASHION_POOL_MAX = 30;
export const FASHION_EXEMPLARS = 3;
export const FASHION_TASTE_TAKE = 30;
export const FASHION_BRIDGES = 3;
/** C.7: style tag lookups per job (non-fashion; cached). */
export const STYLE_TAG_LOOKUPS_MAX = 4;
/** R-7e: how long publishStyle waits for the stage-1 guard after the style call returns. */
export const STAGE1_WAIT_MS = 3_000;
/** R-5: cross-domain recommend waits at most this long after resolve for the More-like-this primary. */
export const BRIDGE_WAIT_MS = 4_000;
/** Deviation from R-5, measured live: with no anchor, recommend waits up to 15 s for bridges (else Wear/Play/Watch stay empty). */
export const BRIDGE_WAIT_NO_ANCHOR_MS = 15_000;

export class StyleStage {
  private readonly stage1 = deferred<Stage1Facts | null>();
  private readonly anchors = deferred<StyleAnchor[]>();
  private readonly primary = deferred<void>();
  private readonly bridgeList: StyleBridge[] = [];
  private stored: StoredStyleReading | null = null;
  private status: StyleSectionStatus | 'running' | 'pending' = 'pending';
  private swatches: Swatch[] = [];
  private pixels: { data: Buffer; width: number; height: number; channels: number } | null = null;
  private earlyRail: Promise<void> | null = null;
  /** A brand anchor's early insights results, kept for the fashion rail (smatch-1). */
  private earlyEntity: { entityId: string; name: string; entities: QlooEntity[]; providerQueryId: string; isReplay: boolean } | null = null;
  /** Subjects whose rail already holds an early entity call's cards (R-4). */
  private readonly earlyBySubject = new Map<string, { entityId: string; count: number }>();
  readonly timings: Record<string, number> = {};

  constructor(private readonly host: StyleHost) {}

  private mark(name: string): void {
    this.timings[name] = Date.now() - this.host.startedAt;
  }

  /** Stage-1 facts arrived (or null: stage 1 failed). Never blocks; the style publish waits at most 3 s for it. */
  setStage1(facts: Stage1Facts | null): void {
    this.stage1.resolve(facts);
  }

  setAnchors(anchors: StyleAnchor[]): void {
    this.anchors.resolve(anchors);
  }

  get sectionStatus(): string {
    return this.status;
  }

  get reading(): StoredStyleReading | null {
    return this.stored;
  }

  bridges(): StyleBridge[] {
    return [...this.bridgeList];
  }

  /** R-5: resolves when the More-like-this primary returned, the style stage ended without rails, or `ms` passed. */
  async waitForBridges(ms: number): Promise<StyleBridge[]> {
    await within(this.primary.promise, ms);
    return this.bridges();
  }

  /**
   * Accepted tags that may be cross-domain signals for `targetType` (C.5):
   * only when the tag is known on that entity type (vocabulary seenOn or
   * /v2/tags parents). Fashion tags are not on movies, so cross-domain
   * mostly relies on bridges.
   */
  signalTagsFor(targetType: string): { id: string; weight: number }[] {
    if (!this.stored) return [];
    const out: { id: string; weight: number }[] = [];
    for (const s of this.stored.subjects)
      for (const c of [...s.aesthetics, ...s.materials, ...s.lineage]) {
        if (!c.qloo || c.held || c.retracted || c.qloo.use === 'reason') continue;
        if (!c.qloo.entity_types.includes(targetType)) continue;
        out.push({ id: c.qloo.tag_ids[0]!, weight: c.qloo.weight });
      }
    return out.slice(0, 3);
  }

  /**
   * TOPIC-1: a Watch rail for a room, building, craft object or dish when nothing else can signal
   * Qloo (no identified entity, no city for places): films Qloo itself tags with the subject's
   * topic (theme "design", "architecture" or "food"; ids recorded in
   * fixtures/qloo/probe-2026-10-24-tune). Only when no fashion or media subject is read.
   */
  topicFor(targetType: string): { topics: readonly StyleTopic[]; subject: StoredSubject } | null {
    if (targetType !== 'urn:entity:movie' || !this.stored) return null;
    const subjects = this.stored.subjects;
    if (subjects.some((x) => x.category === 'fashion' || x.category === 'media')) return null;
    for (const x of subjects) {
      const topics = TOPIC_BY_CATEGORY[x.category];
      if (topics?.length && x.aesthetics.some((a) => !a.held && !a.retracted)) return { topics, subject: x };
    }
    return null;
  }

  /**
   * smatch-1 for cross-domain cards: Qloo's own order, re-ranked by how well each result's own tags
   * match the reading (half and half), so a film tagged "Midcentury design history" or "Culinary
   * cinema" rises for the room or the dish it echoes. Never drops a result.
   */
  rerankCrossDomain<T extends { entity_id: string; tags?: { id: string; name: string }[] }>(entities: readonly T[], styleShare = 0.5, options: { gateFashion?: boolean } = {}): T[] {
    // Wear cards for a garment pass the same product and tier gates as its rail (no couture house
    // next to a casual dress, no eyewear house for a jacket).
    const garment = options.gateFashion ? this.stored?.subjects.find((x) => x.category === 'fashion') : undefined;
    const q = garment ? subjectProfile(garment) : null;
    const kept = q ? entities.filter((e) => !scoreMatch(q, entityProfile(e.tags ?? [])).gate) : entities;
    const scored = this.crossDomainScores(kept);
    const best = Math.max(0, ...scored.map((x) => x.style));
    if (best <= 0 || kept.length < 2) return [...kept];
    return scored
      .map((x) => ({ ...x, score: styleShare * (x.style / best) + (1 - styleShare) / (1 + x.i / 5) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.e);
  }

  /**
   * TOPIC-1 films: only those whose own Qloo tags share a style claim with the reading ("Midcentury
   * modern", "Urban decay", "Ramen", "Cafe"), strongest first. A topic alone ("design") is not a
   * match: with no overlapping film the Watch rail stays empty rather than showing popular films
   * about something else.
   */
  topicFilms<T extends { entity_id: string; tags?: { id: string; name: string }[] }>(entities: readonly T[]): T[] {
    const scored = this.crossDomainScores(entities).filter((x) => x.styleHit);
    const best = Math.max(0, ...scored.map((x) => x.style));
    if (best < TOPIC_MIN_SCORE) return [];
    return scored
      .filter((x) => x.style >= Math.max(TOPIC_MIN_SCORE, TOPIC_MIN_RELATIVE * best))
      .map((x) => ({ ...x, score: TOPIC_STYLE_SHARE * (x.style / best) + (1 - TOPIC_STYLE_SHARE) / (1 + x.i / 5) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.e);
  }

  private crossDomainScores<T extends { entity_id: string; tags?: { id: string; name: string }[] }>(entities: readonly T[]): { e: T; i: number; style: number; styleHit: boolean }[] {
    const profiles = (this.stored?.subjects ?? []).map((x) => subjectProfile(x));
    return entities.map((e, i) => {
      const prof = entityProfile(e.tags ?? []);
      let style = 0;
      let styleHit = false;
      for (const q of profiles) {
        const m = scoreMatch(q, prof, { fashion: false });
        if (m.score > style) {
          style = m.score;
          styleHit = m.styleHit;
        }
      }
      return { e, i, style, styleHit };
    });
  }

  /** The style section for analyses where style does not run (examples, no role, kill switch, budget). */
  async publishOff(status: StyleSectionStatus, reason: string): Promise<void> {
    // A published reading is never taken down by a later failure (B.4).
    if (this.status === 'ready' && status === 'failed') return;
    this.status = status;
    await setAnalysisSection(this.host.ctx.db, this.host.analysisId, 'style', status);
    this.primary.resolve();
    await this.trace('style', { status, reason });
  }

  private async trace(name: string, data: Record<string, unknown>): Promise<void> {
    await this.host.ctx.trace({ kind: 'stage', name, data: { ...data, at_ms: Date.now() - this.host.startedAt }, durationMs: 0, traceId: this.host.traceId });
  }

  /**
   * Plans the style call for this job: a usable vision_style reader, no kill
   * (experimental_analysis_enabled for an experimental role), and room in the
   * job's vision-call budget and (for the real gateway) the spend ledger,
   * including the experimental bucket. Reserved at job start (§B.2).
   */
  static async plan(ctx: StyleJobContext, budget: JobBudget, options: { example: boolean; reserve?: boolean }): Promise<StylePlan> {
    const off = (status: StyleSectionStatus, reason: string): StylePlan => ({ enabled: false, off: { status, reason } });
    if (options.example) return off('empty', 'example');
    const reader = ctx.providers.vlmStyle;
    if (!isUsable(reader.capability())) return off('failed', 'unavailable');
    const gateway = ctx.providers.modelGateway;
    const runner = gateway?.runners.vision_style;
    const experimental = !!gateway?.experimentalRoles.has('vision_style');
    if (experimental) {
      const killed = await activeKills(ctx.db, ctx.job.owner_account_id ?? '00000000-0000-0000-0000-000000000000', ctx.config);
      if (killed.has('experimental_analysis_enabled') || killed.has('concentrate_analysis_enabled')) return off('held', 'paused');
    }
    if (runner && gateway?.ledger) {
      const accountId = ctx.job.owner_account_id;
      if (!accountId) return off('failed', 'no_account');
      if (!(await gateway.ledger.canReserveAll({ accountId, jobId: ctx.job.id }, [runner.profile]))) return off('held', 'daily_limit');
    }
    if (options.reserve !== false && !budget.reserveVisionCalls(1)) return off('held', 'budget');
    return { enabled: true };
  }

  // ---- the style call ------------------------------------------------------

  private async loadImage(): Promise<Uint8Array | null> {
    const key = this.host.capture.private_object_key;
    if (!key) return null;
    const object = await this.host.ctx.providers.storage.get(key);
    return object ? object.body : null;
  }

  /** §A.4: 5 measured swatches on a 64x64 downsample (deterministic). Pixels are kept for G-STYLE-PALETTE. */
  private async measure(bytes: Uint8Array): Promise<Swatch[]> {
    this.pixels = await stylePixels(bytes);
    return computeSwatches(this.pixels.data, this.pixels.width, this.pixels.height, this.pixels.channels);
  }

  private async callModel(bytes: Uint8Array, swatches: readonly StyleSwatch[]): Promise<StyleCallOutput> {
    const { ctx } = this.host;
    const gateway = ctx.providers.modelGateway;
    const runner = gateway?.runners.vision_style;
    const experimental = !!gateway?.experimentalRoles.has('vision_style');
    const counter = attemptCounter();
    const started = Date.now();
    const request = { model_capability: ctx.providers.vlmStyle.id, swatches: swatches.length, vocab_version: VOCAB_VERSION };
    const lists = closedVocabularyLists();
    try {
      const res = await ctx.providers.vlmStyle.readStyle(
        { image: { bytes, mediaType: 'image/jpeg' }, swatches, vocabulary: lists },
        { ...this.host.callOptions('style'), maxRetries: 1, timeoutMs: STYLE_TIMEOUT_MS, onAttempt: counter.observer },
      );
      await recordProviderQuery(ctx.db, {
        parent: { analysisId: this.host.analysisId },
        provider: 'vlm',
        operation: 'read_style',
        request,
        results: {
          model: res.model,
          usable: res.reading.usable,
          subjects: res.reading.subjects.map((s) => ({ id: s.id, category: s.category, aesthetics: s.aesthetics.length })),
          usage: res.usage ?? null,
        },
        status: 'ok',
        durationMs: Date.now() - started,
        queryContext: { stage: 'style', attempts: counter.count(), experimental },
        traceId: this.host.traceId,
      });
      return { reading: res.reading, model: res.model, ms: Date.now() - started, image: res.image, errorCode: null, experimental, profile: runner?.profile.version ?? null };
    } catch (err) {
      if (ctx.signal.aborted || (isProviderError(err) && err.kind === 'aborted')) throw err;
      const e = errorSummary(err);
      await recordProviderQuery(ctx.db, {
        parent: { analysisId: this.host.analysisId },
        provider: 'vlm',
        operation: 'read_style',
        request,
        status: 'error',
        errorCode: e.code,
        httpStatus: e.status,
        durationMs: Date.now() - started,
        queryContext: { stage: 'style', attempts: counter.count(), experimental },
        traceId: this.host.traceId,
      });
      return { reading: null, model: null, ms: Date.now() - started, image: null, errorCode: e.code, experimental, profile: runner?.profile.version ?? null };
    }
  }

  /**
   * The whole stage: measure, read, guard, word, publish (section ready),
   * map to Qloo, build the rails. Never throws for a provider failure: the
   * section becomes failed / empty / held with the reason in the trace.
   */
  async run(): Promise<StyleSectionStatus> {
    const { ctx } = this.host;
    this.status = 'running';
    this.mark('style_started');
    await setAnalysisSection(ctx.db, this.host.analysisId, 'style', 'running');
    const bytes = await this.loadImage();
    if (!bytes) return this.end('failed', 'image_missing');
    let swatches: Swatch[];
    try {
      swatches = await this.measure(bytes);
    } catch {
      return this.end('failed', 'invalid_image');
    }
    this.swatches = swatches;
    const sent = publicSwatches(swatches);
    const out = await ctx.runStage<StyleCallOutput>('style', async () => {
      const pre = this.host.preread ? await this.host.preread() : null;
      if (pre) {
        await recordProviderQuery(ctx.db, {
          parent: { analysisId: this.host.analysisId },
          provider: 'vlm',
          operation: 'read_style',
          request: { source: 'media_analysis', vocab_version: VOCAB_VERSION },
          results: pre.reading ? { model: pre.model, usable: pre.reading.usable, subjects: pre.reading.subjects.length } : undefined,
          status: pre.reading ? 'ok' : 'error',
          errorCode: pre.errorCode,
          durationMs: pre.ms,
          queryContext: { stage: 'style', source: 'media_analysis', experimental: pre.experimental },
          traceId: this.host.traceId,
        });
        return pre;
      }
      return this.callModel(bytes, sent);
    });
    this.mark('style_model_done');
    if (!out.reading) {
      const held = out.errorCode === 'budget_exhausted';
      return this.end(held ? 'held' : 'failed', out.errorCode ?? 'failed');
    }
    // R-7e: the brand, read_text and unusable rules need the stage-1 guard result: wait <= 3 s for it.
    const stage1 = this.stage1.settled ? await this.stage1.promise : await within(this.stage1.promise, STAGE1_WAIT_MS);
    const lists = closedVocabularyLists();
    const guarded = guardStyleReading(out.reading, {
      stage1: stage1 ? { usable: stage1.usable, peopleShown: stage1.peopleShown, visibleText: stage1.visibleText, brands: stage1.brands ?? [] } : null,
      vocabulary: (category, q) => closedTagQuery(lists, category, q),
    });
    if (guarded.discarded || !guarded.reading.usable) {
      await this.trace('style', { status: 'empty', reason: guarded.discarded ? 'unusable_photo' : (out.reading.unusable_reason ?? 'no_styled_subject'), dropped: guarded.dropped });
      return this.end('empty', guarded.discarded ? 'unusable_photo' : 'no_styled_subject', true);
    }
    const evidence: CorroborationEvidence = {
      ...NO_CORROBORATION,
      stage1: new Set(stage1?.styleNames ?? []),
      // Stage 1 and the style reading are both Anthropic-family in profile style-1 (R-8: bar 0.80).
      sameFamily: true,
    };
    const dropped: { path: string; rule: string }[] = [...guarded.dropped];
    const keepRegions = ctx.config.STYLE_SHOW_CLAIM_REGIONS === true;
    const subjects = guarded.reading.subjects.map((s) => {
      const px = this.pixels;
      const inRegion = s.palette.filter((p) => {
        const sw = swatches[p.swatch];
        return !!sw && !!px && swatchPresentInRegion(px.data, px.width, px.height, px.channels, s.region, sw, swatches);
      });
      // BG-1: a colour far more common around the subject than on it is the background (court, wall),
      // unless it is the only colour left (a subject that blends into its setting keeps one swatch).
      const own = inRegion.filter((p) => !(px && swatchIsBackground(px.data, px.width, px.height, px.channels, s.region, swatches[p.swatch]!, swatches)));
      const present = new Set((own.length ? own : inRegion.slice(0, 1)).map((p) => p.swatch));
      return wordSubject({ subject: s, swatches: sent, presentSwatches: present, corroboration: evidence, keepClaimRegions: keepRegions }, dropped);
    });
    // Fashion maps from the vocabulary right away (0 requests), so the first publish already carries its tags.
    const vocab = styleVocabulary();
    for (const s of subjects) if (s.category === 'fashion') mapSubjectTags(s, vocab, new Map());
    this.stored = {
      schema: 'atlas_style_reading_v1',
      wording_version: STYLE_WORDING_VERSION,
      guard_version: STYLE_GUARD_VERSION,
      vocab_version: VOCAB_VERSION,
      rev: 1,
      model: { role: 'vision_style', profile: out.profile, model: out.model!, experimental: out.experimental, ms: out.ms },
      image: { width: out.image?.width ?? 0, height: out.image?.height ?? 0, frame_index: this.host.frameIndex ?? null },
      swatches: sent,
      summary: guarded.reading.summary,
      subjects,
      dropped,
      held: guarded.held,
      retracted: [],
    };
    await this.publish('ready');
    this.mark('style_published');
    await this.applyThingTitle();
    await this.trace('style', {
      status: 'ready',
      model: out.model,
      model_ms: out.ms,
      experimental: out.experimental,
      subjects: subjects.map((s) => ({ id: s.id, category: s.category, aesthetics: s.aesthetics.length, held: s.aesthetics.filter((a) => a.held).length })),
      dropped: dropped.length,
      held: guarded.held.length,
      timings: this.timings,
    });
    try {
      await this.buildRails();
    } catch (err) {
      if (this.host.ctx.signal.aborted || (isProviderError(err) && err.kind === 'aborted')) throw err;
      // The reading stays published: a rail failure never takes the style card down.
      await this.trace('style:rail', { status: 'failed', error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : 'unknown' });
      if (this.stored)
        for (const s of this.stored.subjects) {
          const key = `more_like_this:${s.id}`;
          await setAnalysisSection(this.host.ctx.db, this.host.analysisId, key, 'failed').catch(() => undefined);
        }
    } finally {
      this.primary.resolve();
    }
    return 'ready';
  }

  private async end(status: StyleSectionStatus, reason: string, traced = false): Promise<StyleSectionStatus> {
    this.status = status;
    await publishForCapture(this.host.ctx.db, this.host.capture.id, this.host.ctx.ensureActive, async (tx) => {
      await setAnalysisSection(tx, this.host.analysisId, 'style', status);
    });
    this.primary.resolve();
    if (!traced) await this.trace('style', { status, reason, timings: this.timings });
    return status;
  }

  /**
   * TITLE-1: on a photo that shows people the stage-1 guard replaces any headline about them by
   * "People in your photo", which hides a garment- or artwork-focused photo behind a line about
   * people. When the guarded style reading names a fashion or media THING (a person-free label:
   * thingLabel and G-STYLE-PERSON already ran), that thing becomes the title instead. Only the
   * neutral line is replaced, never a real headline; the interpretation stays neutral. Idempotent:
   * the compiler calls it again at the end, after stage 2 may have restored the neutral line.
   */
  async applyThingTitle(): Promise<void> {
    const s = this.stored?.subjects.find((x) => x.category === 'fashion' || x.category === 'media');
    const label = s?.label.trim();
    if (!label || styleTextAboutPerson(label)) return;
    const title = label.slice(0, 120);
    await publishForCapture(this.host.ctx.db, this.host.capture.id, this.host.ctx.ensureActive, async (tx) => {
      const { rowCount } = await tx.query(`UPDATE analyses SET title = $2 WHERE id = $1 AND title = $3`, [this.host.analysisId, title, NEUTRAL_PEOPLE_TITLE]);
      if (rowCount) await tx.query(`UPDATE discovery_items SET title = $2, updated_at = now() WHERE capture_id = $1 AND kind = 'capture' AND title = $3`, [this.host.capture.id, title, NEUTRAL_PEOPLE_TITLE]);
    });
  }

  /** One UPDATE of analyses.style_reading (B.4) plus the section status. */
  private async publish(status: StyleSectionStatus): Promise<void> {
    const stored = this.stored!;
    this.status = status;
    await publishForCapture(this.host.ctx.db, this.host.capture.id, this.host.ctx.ensureActive, async (tx) => {
      await tx.query(
        `UPDATE analyses SET style_reading = $2::jsonb, style_reading_version = $3,
                experimental = experimental OR $4
          WHERE id = $1`,
        [this.host.analysisId, JSON.stringify(stored), stored.schema, stored.model.experimental],
      );
      await setAnalysisSection(tx, this.host.analysisId, 'style', status);
    });
  }

  // ---- Qloo mapping and rails ------------------------------------------------

  private async userCity(): Promise<string | null> {
    if (this.host.owner.kind !== 'account') return null;
    const { rows } = await this.host.ctx.db.query<{ city: string | null }>(`SELECT preferences->>'city' AS city FROM accounts WHERE id = $1`, [this.host.owner.accountId]);
    const city = rows[0]?.city?.trim();
    return city ? city.slice(0, 80) : null;
  }

  /** /v2/tags lookups for non-fashion subjects (C.2): de-duplicated, <= 4 per job, served from the 24 h cache. */
  private async lookupTags(queries: readonly string[]): Promise<Map<string, QlooTag[]>> {
    const { ctx } = this.host;
    const out = new Map<string, QlooTag[]>();
    const caps = ctx.providers.qloo.capability();
    for (const query of queries.slice(0, STYLE_TAG_LOOKUPS_MAX)) {
      const { rows } = await ctx.db.query<{ results: { id: string; name: string; type: string; parents?: string[] }[] | null }>(
        `SELECT results FROM provider_queries
          WHERE provider = 'qloo' AND operation = 'style_tags' AND status IN ('ok', 'empty')
            AND sanitized_request->'query'->>'filter.query' = $1 AND cache_expiry > now()
          ORDER BY retrieved_at DESC LIMIT 1`,
        [query],
      );
      if (rows[0]?.results) {
        out.set(query, rows[0].results);
        continue;
      }
      if (!isUsable(caps.tags) || this.host.budget.remaining('qloo') === 0 || this.host.pastSoftDeadline()) continue;
      const counter = attemptCounter();
      try {
        const call = await this.host.qlooCall('style:tags', (o) => ctx.providers.qloo.lookupTags({ query, take: 10 }, { ...o, onAttempt: counter.observer }));
        const res = call.value;
        out.set(query, res.data);
        await recordProviderQuery(ctx.db, {
          parent: { analysisId: this.host.analysisId },
          provider: 'qloo',
          operation: 'style_tags',
          request: res.request,
          results: res.data.map((t) => ({ id: t.id, name: t.name, type: t.type, parents: t.parents ?? [] })),
          status: res.data.length ? 'ok' : 'empty',
          httpStatus: res.status,
          durationMs: res.duration_ms,
          isReplay: res.is_replay,
          queryContext: { stage: 'style:tags', attempts: call.attempts },
          traceId: this.host.traceId,
          cacheTtlSeconds: PROVIDER_CACHE_TTL_SECONDS,
        });
      } catch (err) {
        if (isProviderError(err) && err.kind === 'aborted') throw err;
        const e = errorSummary(err);
        await recordProviderQuery(ctx.db, {
          parent: { analysisId: this.host.analysisId },
          provider: 'qloo',
          operation: 'style_tags',
          request: { query },
          status: 'error',
          errorCode: e.code,
          httpStatus: e.status,
          queryContext: { stage: 'style:tags', attempts: (err as { attempts?: number }).attempts ?? counter.count() },
          traceId: this.host.traceId,
        });
      }
    }
    return out;
  }

  /**
   * C.1: anchors whose stage-1 region overlaps the subject; with no regions, the first subject takes
   * them. Overlap is IoU >= 0.1 OR the anchor's box lying mostly inside the subject (>= 50 % of the
   * anchor's area): a logo or wordmark is far smaller than the garment it is printed on, so its IoU
   * with the garment is tiny (measured: a FILA chest print never joined the tee's rail).
   */
  private entityFor(subject: StoredSubject, index: number, anchors: readonly StyleAnchor[]): StyleAnchor | null {
    const withBoxes = anchors.filter((a) => a.boxes.length);
    const overlapping = withBoxes.filter((a) => a.boxes.some((b) => iou(b, subject.region) >= 0.1 || insideShare(b, subject.region) >= 0.5));
    if (overlapping.length) return overlapping[0]!;
    if (index === 0) return anchors.find((a) => !a.boxes.length) ?? null;
    return null;
  }

  /**
   * R-4: with an identified anchor, the entity call runs right after resolve
   * (first cards about 4-5 s). Its cards go to the first subject's rail
   * (re-keyed to the subject E overlaps once the reading lands); the
   * style-constrained call is then appended as the secondary list. Cards
   * already shown are never removed or reordered.
   */
  startEarlyEntityRail(anchors: readonly StyleAnchor[]): void {
    const e = anchors.find((a) => a.types.some((t) => t === 'urn:entity:brand' || t === 'urn:entity:movie' || t === 'urn:entity:artist'));
    if (!e || this.earlyRail) return;
    this.earlyRail = (async () => {
      const type = e.types.includes('urn:entity:brand') ? 'urn:entity:brand' : e.types.includes('urn:entity:movie') ? 'urn:entity:movie' : 'urn:entity:artist';
      const request: QlooInsightsRequest = {
        filterType: type,
        signalEntities: [e.entityId],
        ...(type === 'urn:entity:brand' ? { filterTags: ['urn:tag:genre:brand:fashion'] } : {}),
        explainability: true,
        take: 20,
      };
      const res = await this.insights('style:mlt:early', request, false, { subjectId: 's1', recipe: 'early_entity' });
      if (!res) return;
      // smatch-1: a brand's taste neighbours span every product (eyewear, jewellery, fragrance houses):
      // they wait for the reading, which gates and re-ranks them with the rest of the rail.
      if (type === 'urn:entity:brand') {
        this.earlyEntity = { entityId: e.entityId, name: e.name, entities: res.entities, providerQueryId: res.providerQueryId, isReplay: res.isReplay };
        return;
      }
      const anchorIds = new Set(anchors.map((a) => a.entityId));
      const entities = res.entities.filter((x) => !anchorIds.has(x.entity_id));
      const candidates = fuseRail(entities, [], []);
      const added = await this.publishRail('s1', candidates, [], { via: 'entity', entityName: e.name, palette: [], providerQueryId: res.providerQueryId, isReplay: res.isReplay, rev: 0, append: false });
      this.earlyBySubject.set('s1', { entityId: e.entityId, count: added });
      if (added) {
        this.mark('rail_first_cards');
        for (const c of candidates.slice(0, 2)) this.bridgeList.push({ entityId: c.entity.entity_id, name: c.entity.name, subjectId: 's1', aesthetic: null });
        this.primary.resolve();
      }
    })().catch(() => undefined);
  }

  private async insights(
    stage: string,
    request: QlooInsightsRequest,
    tagOnly: boolean,
    context: Record<string, unknown>,
  ): Promise<{ entities: QlooEntity[]; providerQueryId: string; isReplay: boolean } | null> {
    const { ctx } = this.host;
    if (!isUsable(ctx.providers.qloo.capability().insights) || this.host.budget.remaining('qloo') === 0 || this.host.pastSoftDeadline()) return null;
    const counter = attemptCounter();
    const started = Date.now();
    try {
      const call = await this.host.qlooCall(stage, (o) =>
        ctx.providers.qloo.insights(request, { ...o, ...(tagOnly ? { timeoutMs: TAG_ONLY_TIMEOUT_MS } : {}), onAttempt: counter.observer }),
      );
      const res = call.value;
      const providerQueryId = await recordProviderQuery(ctx.db, {
        parent: { analysisId: this.host.analysisId },
        provider: 'qloo',
        operation: 'insights',
        request: res.request,
        results: res.data.entities.map((x, i) => ({ rank: i + 1, entity_id: x.entity_id, name: x.name, affinity: x.query?.affinity ?? null, explainability: x.query?.explainability ?? null })),
        status: res.data.entities.length ? 'ok' : 'empty',
        httpStatus: res.status,
        durationMs: res.duration_ms,
        isReplay: res.is_replay,
        queryContext: { stage, rail: 'more_like_this', attempts: call.attempts, ...context },
        traceId: this.host.traceId,
        cacheTtlSeconds: PROVIDER_CACHE_TTL_SECONDS,
      });
      return { entities: res.data.entities, providerQueryId, isReplay: res.is_replay };
    } catch (err) {
      if (isProviderError(err) && err.kind === 'aborted') throw err;
      const e = errorSummary(err);
      const attempts = (err as { attempts?: number }).attempts ?? counter.count();
      if (e.code !== 'budget_exhausted' || attempts > 0)
        await recordProviderQuery(ctx.db, {
          parent: { analysisId: this.host.analysisId },
          provider: 'qloo',
          operation: 'insights',
          request: { filterType: request.filterType, filterTags: request.filterTags ?? [], signalEntities: request.signalEntities ?? [] },
          status: 'error',
          errorCode: e.code,
          httpStatus: e.status,
          durationMs: Date.now() - started,
          queryContext: { stage, rail: 'more_like_this', attempts, ...context },
          traceId: this.host.traceId,
        });
      return null;
    }
  }

  private async buildRails(): Promise<void> {
    const { ctx } = this.host;
    const stored = this.stored!;
    const vocab = styleVocabulary();
    const anchors = (await within(this.anchors.promise, Math.max(0, this.host.startedAt + ctx.config.ANALYSIS_DEADLINE_MS * 0.6 - Date.now()))) ?? [];
    let changed = false;
    // Entities per subject (C.1), Qloo links (C.3 brand bonus) and Qloo-entity corroboration (A.6).
    const entityTags = new Set<string>();
    stored.subjects.forEach((s, i) => {
      const e = this.entityFor(s, i, anchors);
      if (!e) return;
      s.entity = { id: e.entityId, name: e.name, types: e.types };
      s.qloo_links = e.types.includes('urn:entity:brand') ? qlooLinks({ tags: e.tags.map((t) => ({ id: t.id, name: t.name, type: t.type })) }) : [];
      for (const t of e.tags) if (!/:(?:target_|market_archetype)/.test(t.id)) entityTags.add(normalizeStyleName(t.name));
      changed = true;
    });
    if (entityTags.size) {
      const ev: CorroborationEvidence = { ...NO_CORROBORATION, qlooEntity: entityTags };
      for (const s of stored.subjects) {
        if (!s.entity) continue;
        const r = rewordAfterStage2(s, ev);
        if (r.upgraded.length || r.released.length) changed = true;
      }
    }
    // Tag lookups for non-fashion subjects, then map every subject.
    const queries = [...new Set(stored.subjects.filter((s) => s.category !== 'fashion').flatMap((s) => tagLookupQueries(s)))];
    const tagResults = queries.length ? await this.lookupTags(queries) : new Map<string, QlooTag[]>();
    for (const s of stored.subjects) mapSubjectTags(s, vocab, tagResults);
    if (changed || queries.length) {
      stored.rev += 1;
      await this.publish('ready');
    }
    const city = await this.userCity();
    if (this.earlyRail) await this.earlyRail;
    // Re-key the early entity rail to the subject its entity overlaps (R-4).
    const early = this.earlyBySubject.get('s1');
    if (early?.count) {
      const owner = stored.subjects.find((s) => s.entity?.id === early.entityId);
      if (owner && owner.id !== 's1') {
        await publishForCapture(ctx.db, this.host.capture.id, ctx.ensureActive, async (tx) => {
          await tx.query(`UPDATE recommendations SET subject_id = $2 WHERE analysis_id = $1 AND rail = 'more_like_this' AND subject_id = 's1'`, [this.host.analysisId, owner.id]);
          await setAnalysisSection(tx, this.host.analysisId, `more_like_this:${owner.id}`, 'ready');
        });
        this.earlyBySubject.delete('s1');
        this.earlyBySubject.set(owner.id, early);
      }
    }
    for (const s of stored.subjects.slice(0, LIMITS.styleSubjectsMax)) await this.buildSubjectRail(s, anchors, city);
  }

  private async buildSubjectRail(s: StoredSubject, anchors: readonly StyleAnchor[], city: string | null): Promise<void> {
    const { ctx } = this.host;
    const stored = this.stored!;
    const key = `more_like_this:${s.id}`;
    if (s.category === 'fashion' && !this.earlyBySubject.get(s.id)?.count) return this.buildFashionRail(s, anchors);
    const accepted = acceptedTags(s);
    const F = bestFilterTag(s);
    // Exemplars must carry the subject's primary style tag (F, else its strongest mapped aesthetic).
    const primaryTag = primaryStyleTag(s);
    const exemplars =
      s.category === 'fashion' && !s.entity && primaryTag
        ? selectExemplars(styleVocabulary().brands, accepted, primaryTag.id, { exclude: new Set(anchors.map((a) => a.entityId)) })
        : [];
    const plan: RailPlan = planMoreLikeThis({
      subject: s,
      entity: s.entity,
      filterTag: F?.id ?? null,
      accepted,
      exemplars,
      city,
      interiorBrandsEnabled: ctx.config.STYLE_INTERIOR_BRANDS === true,
    });
    const early = this.earlyBySubject.get(s.id);
    await this.trace('style:rail', { subject: s.id, recipe: plan.recipe, empty_reason: plan.emptyReason, exemplars: exemplars.length, filter_tag: F?.id ?? null, early: early?.count ?? 0 });
    if (!plan.primary) {
      if (!early?.count) await this.railStatus(key, 'empty', plan.emptyReason);
      return;
    }
    await this.railStatus(key, 'running', null);
    // smatch-1: reasons no longer cite the photo's palette: a place or film never shares it, and a
    // palette swatch can still be partly background, so the clause read as overlap it was not.
    const palette: string[] = [];
    const anchorIds = new Set(anchors.map((a) => a.entityId));
    const clean = (list: readonly QlooEntity[], request: QlooInsightsRequest) =>
      list.filter((x) => !anchorIds.has(x.entity_id) && !(request.filterLocationQuery || request.signalLocationQuery ? outsideCity(x, (request.filterLocationQuery ?? request.signalLocationQuery)!) : false));
    // With an early entity rail, the primary entity call already ran: the style-constrained call is the secondary.
    const primaryReq = early?.count && plan.recipe === 'fashion_entity' ? null : plan.primary;
    const a = primaryReq ? await this.insights(`style:mlt:${s.id}`, primaryReq, plan.tagOnly, { subject_id: s.id, recipe: plan.recipe, list: 'primary' }) : null;
    let listA = a ? clean(a.entities, plan.primary) : [];
    let weightA = 1;
    const verdictA = a ? flatVerdict(plan.primary, listA, accepted) : 'ok';
    if (verdictA === 'flat_discarded') listA = [];
    if (verdictA === 'flat_kept') weightA = 0;
    // A garment with no identified brand: a card must carry the subject's primary style tag, so the rail
    // is the same style family and not only a shared material (measured live: "casual" plus "faux leather"
    // filled a varsity bomber's rail with unrelated fast-fashion brands).
    const styleIds = primaryTag ? new Set([primaryTag.id, ...(s.aesthetics.find((x) => x.name === primaryTag.claimName)?.qloo?.alt_ids ?? [])]) : null;
    const needsStyle = !plan.entity && s.category === 'fashion' && !!styleIds;
    const carries = (e: QlooEntity) => !needsStyle || e.tags.some((t) => styleIds!.has(t.id));
    listA = listA.filter(carries);
    // Bridges: the top 2 real results of an entity- or filter-backed call (never a tag-only call's top
    // results, never places: a stadium bridging into Wear gave sports merchandise in the live check).
    if (plan.bridgeable && listA.length && verdictA === 'ok') {
      const usable = dedupeByName(fuseRail(listA, [], accepted).filter((c) => (plan.entity || c.overlap > 0) && !c.entity.types.includes('urn:entity:place')));
      for (const c of usable.slice(0, 2)) this.bridgeList.push({ entityId: c.entity.entity_id, name: c.entity.name, subjectId: s.id, aesthetic: primaryTag?.claimName ?? null });
    }
    if (a) {
      this.primary.resolve();
      this.mark(`rail_primary_${s.id}`);
    }
    // Too few on-style results without a filter: the secondary call is style-constrained by the primary
    // style tag itself (a deviation from C.2 rule 7 for "resembles" tags, recorded in docs/pipeline.md;
    // nothing is asserted to the user: reasons keep the "resembles" template).
    const styleConstrained: QlooInsightsRequest | null =
      needsStyle && !F && primaryTag && plan.primary ? { ...plan.primary, filterTags: [primaryTag.id], filterPopularityMin: undefined } : null;
    const secondaryReq = early?.count && plan.recipe === 'fashion_entity' ? plan.primary : (styleConstrained ?? plan.secondary);
    let b: Awaited<ReturnType<StyleStage['insights']>> = null;
    if (secondaryReq && (listA.length < SECONDARY_BELOW || (early?.count && secondaryReq === plan.primary)))
      b = await this.insights(`style:mlt:${s.id}:b`, secondaryReq, false, { subject_id: s.id, recipe: plan.recipe, list: 'secondary' });
    let listB = b ? clean(b.entities, secondaryReq!).filter(carries) : [];
    const verdictB = b ? flatVerdict(secondaryReq!, listB, accepted) : 'ok';
    if (verdictB === 'flat_discarded') listB = [];
    let fused = fuseRail(listA, listB, accepted, { primary: weightA, secondary: verdictB === 'flat_kept' ? 0 : 0.6 });
    // Without an identified entity a card is "more like this" only through real style overlap (C.4):
    // a result sharing none of the subject's accepted tags is left out (empty beats junk).
    if (!plan.entity) fused = fused.filter((c) => c.overlap > 0);
    fused = dedupeByName(fused);
    const providerQueryId = a?.providerQueryId ?? b?.providerQueryId ?? null;
    if (!fused.length || !providerQueryId) {
      if (!early?.count) await this.railStatus(key, 'empty', a || b ? 'flat_or_empty' : 'qloo_unavailable');
      else await this.railStatus(key, 'ready', null);
      await this.trace('style:rail', { subject: s.id, status: early?.count ? 'ready' : 'empty', verdict_a: verdictA, verdict_b: verdictB, warning: verdictA !== 'ok' ? 'Q-FLAT' : undefined });
      return;
    }
    const via = plan.entity ? 'entity' : plan.recipe === 'fashion_exemplar' ? 'exemplar' : 'overlap';
    const added = await this.publishRail(s.id, fused, accepted, {
      via,
      entityName: plan.entity?.name ?? null,
      palette,
      providerQueryId,
      providerQueryIds: [a?.providerQueryId, b?.providerQueryId].filter((x): x is string => !!x),
      isReplay: (a?.isReplay ?? false) || (b?.isReplay ?? false),
      rev: stored.rev,
      append: !!early?.count,
      existing: early?.count ?? 0,
    });
    if (added && !this.timings.rail_first_cards) this.mark('rail_first_cards');
    await this.trace('style:rail', { subject: s.id, status: 'ready', cards: added + (early?.count ?? 0), verdict_a: verdictA, verdict_b: verdictB, timings: this.timings });
  }

  /**
   * smatch-1 fashion rail. The reading's own words pick the closest catalogue
   * brands of the same product family (rankCatalogue: product, tier and region
   * gates, rare words first). Two Qloo calls run in parallel:
   *  A: taste neighbours of the identified brand (logo) and the top 3
   *     catalogue matches, filtered to the product's Qloo genre (footwear,
   *     bags, formalwear, ...), take 30;
   *  B: Qloo ranks the catalogue pool itself (filter.results.entities), so
   *     the best-matching brands can be cards with a real Qloo response.
   * Every result is then gated and re-ranked by its OWN Qloo tags against the
   * reading (style first, Qloo order second): Qloo's co-liked popular houses
   * of other products, tiers or regions no longer lead the rail.
   */
  private async buildFashionRail(s: StoredSubject, anchors: readonly StyleAnchor[]): Promise<void> {
    const stored = this.stored!;
    const key = `more_like_this:${s.id}`;
    const anchor = s.entity ? (anchors.find((a) => a.entityId === s.entity!.id) ?? null) : null;
    const brandAnchor = anchor && anchor.types.includes('urn:entity:brand') ? anchor : null;
    const q = subjectProfile(s, brandAnchor?.tags ?? []);
    const anchorIds = new Set(anchors.map((a) => a.entityId));
    const pool = rankCatalogue(q, { exclude: anchorIds, max: FASHION_POOL_MAX });
    const genre = genreFilterFor(q.kind);
    const filterTags = [genre ?? FASHION_BRAND_TAG];
    const signals = [...(brandAnchor ? [brandAnchor.entityId] : []), ...pool.slice(0, FASHION_EXEMPLARS).map((x) => x.id)];
    await this.trace('style:rail', { subject: s.id, recipe: 'fashion_affinity', kind: q.kind, tier: q.tier, regions: [...q.regions], genre, pool: pool.length, exemplars: signals.length });
    if (!signals.length) {
      await this.railStatus(key, 'empty', 'no_signal');
      return;
    }
    await this.railStatus(key, 'running', null);
    const reqA: QlooInsightsRequest = { filterType: 'urn:entity:brand', filterTags, signalEntities: signals, explainability: true, take: FASHION_TASTE_TAKE };
    const reqB: QlooInsightsRequest | null = pool.length ? { filterType: 'urn:entity:brand', filterTags: [FASHION_BRAND_TAG], filterResultsEntities: pool.map((x) => x.id), take: pool.length } : null;
    const [a, b] = await Promise.all([
      this.insights(`style:mlt:${s.id}`, reqA, false, { subject_id: s.id, recipe: 'fashion_affinity', list: 'taste' }),
      reqB ? this.insights(`style:mlt:${s.id}:pool`, reqB, false, { subject_id: s.id, recipe: 'fashion_affinity', list: 'pool' }) : Promise.resolve(null),
    ]);
    const early = brandAnchor && this.earlyEntity?.entityId === brandAnchor.entityId ? this.earlyEntity : null;
    if (a || b) {
      this.primary.resolve();
      this.mark(`rail_primary_${s.id}`);
    }
    const ranked = rankAffinity(
      q,
      [
        { list: a?.entities ?? [], prior: true, fromEntity: false },
        { list: early?.entities ?? [], prior: true, fromEntity: true },
        { list: b?.entities ?? [], prior: false, fromEntity: false },
      ],
      { exclude: anchorIds, entityLinked: !!brandAnchor, signalNames: new Map(pool.slice(0, FASHION_EXEMPLARS).map((x) => [x.id, x.name])) },
    );
    const providerQueryIds = [a?.providerQueryId, early?.providerQueryId, b?.providerQueryId].filter((x): x is string => !!x);
    if (!ranked.candidates.length || !providerQueryIds.length) {
      await this.railStatus(key, 'empty', a || b ? 'flat_or_empty' : 'qloo_unavailable');
      await this.trace('style:rail', { subject: s.id, status: 'empty', recipe: 'fashion_affinity', gated: ranked.gated });
      return;
    }
    // Bridges for cross-domain recommend (C.5): the three most on-style results, not Qloo's first two
    // (three average out one brand's audience: one bridge alone pulled a whole rail into its market).
    for (const c of ranked.candidates.filter((x) => !x.via).slice(0, FASHION_BRIDGES))
      this.bridgeList.push({ entityId: c.entity.entity_id, name: c.entity.name, subjectId: s.id, aesthetic: s.aesthetics.find((x) => !x.held && !x.retracted)?.name ?? null });
    const added = await this.publishAffinityRail(s.id, ranked.candidates, {
      entityName: brandAnchor?.name ?? null,
      providerQueryIds,
      isReplay: (a?.isReplay ?? false) || (b?.isReplay ?? false) || (early?.isReplay ?? false),
      rev: stored.rev,
    });
    if (added && !this.timings.rail_first_cards) this.mark('rail_first_cards');
    await this.trace('style:rail', { subject: s.id, status: added ? 'ready' : 'empty', recipe: 'fashion_affinity', cards: added, gated: ranked.gated, timings: this.timings });
  }

  /** Inserts affinity rail cards (rail = more_like_this) with their own reasons and style_match. */
  private async publishAffinityRail(
    subjectId: string,
    ranked: readonly AffinityCandidate[],
    o: { entityName: string | null; providerQueryIds: readonly string[]; isReplay: boolean; rev: number },
  ): Promise<number> {
    const { ctx } = this.host;
    const excluded = await this.host.excludedKeys();
    const pool = ranked.filter((c) => kindFor(c.entity.types) && !excluded.has(`qloo:${c.entity.entity_id}`) && !this.host.usedKeys.has(`qloo:${c.entity.entity_id}`));
    const byId = new Map(pool.map((c) => [c.entity.entity_id, c]));
    const picked = selectRail(
      pool.map((c) => ({ entity: c.entity, sources: ['primary' as const], overlap: c.match.score, score: c.score })),
      LIMITS.moreLikeThisPerSubject,
    ).map((x) => byId.get(x.entity.entity_id)!);
    let added = 0;
    await publishForCapture(ctx.db, this.host.capture.id, ctx.ensureActive, async (tx) => {
      const { rows } = await tx.query<{ next: number }>(`SELECT COALESCE(MAX(rank), 999) + 1 AS next FROM recommendations WHERE analysis_id = $1 AND rail = 'more_like_this' AND subject_id = $2`, [this.host.analysisId, subjectId]);
      let rank = Math.max(1000, rows[0]?.next ?? 1000);
      for (const c of picked) {
        const e = c.entity;
        const kc = kindFor(e.types)!;
        const viaEntity = !!o.entityName && c.fromEntity;
        const reason = c.via ? `Shares a taste with ${c.via}, a close match for this style` : affinityReason(c.match.hits, { entityName: viaEntity ? o.entityName : null });
        const claims: StyleMatchClaim[] = c.via ? [] : matchClaims(c.match.hits);
        const match: StyleMatch = {
          subject_id: subjectId,
          claims,
          palette: [],
          via_entity: viaEntity ? o.entityName : (c.via ?? null),
          via: viaEntity ? 'entity' : c.via ? 'exemplar' : 'overlap',
          rail: 'more_like_this',
        };
        const itemKey = `qloo:${e.entity_id}`;
        const itemId = await upsertDiscoveryItem(tx, this.host.owner, {
          kind: kc.kind,
          category: kc.category,
          canonicalKey: itemKey,
          title: e.name,
          displayMetadata: {
            subtitle: null,
            ...(imageFromQlooProperties(e.properties, e.name) ? { image: imageFromQlooProperties(e.properties, e.name)! } : {}),
            ...(destinationFromQlooProperties(e.properties) ? { destination_url: destinationFromQlooProperties(e.properties)! } : {}),
            example: o.isReplay,
          },
          externalIds: { qloo: e.entity_id },
          resolvedAnchorIds: [],
        });
        const recId = await insertRecommendation(tx, {
          analysisId: this.host.analysisId,
          discoveryItemId: itemId,
          category: kc.category,
          rank: rank++,
          title: e.name,
          externalIds: { qloo: e.entity_id },
          displayReason: reason,
          origin: o.isReplay ? 'replay' : 'qloo',
          providerQueryIds: [...o.providerQueryIds],
          contributingReferenceIds: [],
        });
        await tx.query(`UPDATE recommendations SET rail = 'more_like_this', subject_id = $2, style_match = $3::jsonb, reading_rev = $4 WHERE id = $1`, [recId, subjectId, JSON.stringify(match), o.rev]);
        this.host.usedKeys.add(itemKey);
        added++;
      }
      await setAnalysisSection(tx, this.host.analysisId, `more_like_this:${subjectId}`, added > 0 ? 'ready' : 'empty');
    });
    return added;
  }

  private async railStatus(key: string, status: 'running' | 'ready' | 'empty' | 'failed', reason: string | null): Promise<void> {
    await publishForCapture(this.host.ctx.db, this.host.capture.id, this.host.ctx.ensureActive, async (tx) => {
      await setAnalysisSection(tx, this.host.analysisId, key, status);
      if (reason) await tx.query(`UPDATE analyses SET section_statuses = section_statuses || jsonb_build_object($2::text, $3::text) WHERE id = $1`, [this.host.analysisId, `${key}:reason`, reason]);
    });
  }

  /** Inserts rail cards (rail = more_like_this) with reasons from real overlap (C.4) and the style_match structure. */
  private async publishRail(
    subjectId: string,
    candidates: readonly RailCandidate[],
    accepted: readonly AcceptedTag[],
    o: {
      via: StyleMatch['via'];
      entityName: string | null;
      palette: readonly string[];
      providerQueryId: string;
      providerQueryIds?: readonly string[];
      isReplay: boolean;
      rev: number;
      append: boolean;
      existing?: number;
    },
  ): Promise<number> {
    const { ctx } = this.host;
    const excluded = await this.host.excludedKeys();
    const pool = candidates.filter((c) => kindFor(c.entity.types) && !excluded.has(`qloo:${c.entity.entity_id}`) && !this.host.usedKeys.has(`qloo:${c.entity.entity_id}`));
    const slots = LIMITS.moreLikeThisPerSubject - (o.existing ?? 0);
    const picked = slots > 0 ? selectRail(pool, slots) : [];
    let added = 0;
    await publishForCapture(ctx.db, this.host.capture.id, ctx.ensureActive, async (tx) => {
      const { rows } = await tx.query<{ next: number }>(`SELECT COALESCE(MAX(rank), 999) + 1 AS next FROM recommendations WHERE analysis_id = $1 AND rail = 'more_like_this' AND subject_id = $2`, [this.host.analysisId, subjectId]);
      let rank = Math.max(1000, rows[0]?.next ?? 1000);
      for (const c of picked) {
        const e = c.entity;
        const kc = kindFor(e.types)!;
        const claims: StyleMatchClaim[] = sharedClaims(accepted, e.tags.map((t) => t.id));
        const reason = buildStyleReason({ claims, palette: o.palette, via: o.via === 'exemplar' ? 'overlap' : o.via, entityName: o.entityName });
        const match: StyleMatch = { subject_id: subjectId, claims, palette: claims.some((x) => x.slot === 'aesthetics') ? o.palette.slice(0, 2) : [], via_entity: o.via === 'entity' ? o.entityName : null, via: o.via, rail: 'more_like_this' };
        const itemKey = `qloo:${e.entity_id}`;
        const itemId = await upsertDiscoveryItem(tx, this.host.owner, {
          kind: kc.kind,
          category: kc.category,
          canonicalKey: itemKey,
          title: e.name,
          displayMetadata: {
            subtitle: null,
            ...(imageFromQlooProperties(e.properties, e.name) ? { image: imageFromQlooProperties(e.properties, e.name)! } : {}),
            ...(destinationFromQlooProperties(e.properties) ? { destination_url: destinationFromQlooProperties(e.properties)! } : {}),
            example: o.isReplay,
          },
          externalIds: { qloo: e.entity_id },
          resolvedAnchorIds: [],
        });
        const recId = await insertRecommendation(tx, {
          analysisId: this.host.analysisId,
          discoveryItemId: itemId,
          category: kc.category,
          rank: rank++,
          title: e.name,
          externalIds: { qloo: e.entity_id },
          displayReason: reason,
          origin: o.isReplay ? 'replay' : 'qloo',
          providerQueryIds: o.providerQueryIds?.length ? o.providerQueryIds : [o.providerQueryId],
          contributingReferenceIds: [],
        });
        await tx.query(`UPDATE recommendations SET rail = 'more_like_this', subject_id = $2, style_match = $3::jsonb, reading_rev = $4 WHERE id = $1`, [recId, subjectId, JSON.stringify(match), o.rev]);
        this.host.usedKeys.add(itemKey);
        added++;
      }
      await setAnalysisSection(tx, this.host.analysisId, `more_like_this:${subjectId}`, added + (o.existing ?? 0) > 0 ? 'ready' : 'empty');
    });
    return added;
  }

  /**
   * The stage-2 corroboration pass (A.6, B.4): wording only moves up, held
   * claims may be released, a stage-2 veto marks a claim retracted. Rails are
   * never re-queried; a card whose only overlap was the retracted claim and
   * that did not come from an entity signal is soft-hidden, others get their
   * reason recomputed from the overlap that remains (R-6).
   */
  async corroborate(stage2: { names: readonly string[]; vetoed: readonly string[] }): Promise<{ upgraded: number; released: number; retracted: number }> {
    if (!this.stored || this.status !== 'ready') return { upgraded: 0, released: 0, retracted: 0 };
    const ev: CorroborationEvidence = {
      ...NO_CORROBORATION,
      stage2: new Set(stage2.names.map(normalizeStyleName)),
      vetoed: new Set(stage2.vetoed.map(normalizeStyleName)),
      sameFamily: true,
    };
    const totals = { upgraded: 0, released: 0, retracted: 0 };
    const retractedNames = new Map<string, Set<string>>();
    for (const s of this.stored.subjects) {
      const r = rewordAfterStage2(s, ev);
      totals.upgraded += r.upgraded.length;
      totals.released += r.released.length;
      totals.retracted += r.retracted.length;
      this.stored.retracted.push(...r.retracted);
      if (r.retracted.length) retractedNames.set(s.id, new Set(s.aesthetics.filter((a) => a.retracted).map((a) => a.name)));
      if (r.released.length) mapSubjectTags(s, styleVocabulary(), new Map());
    }
    if (!totals.upgraded && !totals.released && !totals.retracted) return totals;
    this.stored.rev += 1;
    await this.publish('ready');
    // R-6: recompute reasons on the affected cards; hide those left without any overlap or entity.
    if (retractedNames.size) {
      const { ctx } = this.host;
      await publishForCapture(ctx.db, this.host.capture.id, ctx.ensureActive, async (tx) => {
        const { rows } = await tx.query<{ id: string; subject_id: string; style_match: StyleMatch | null }>(
          `SELECT id, subject_id, style_match FROM recommendations WHERE analysis_id = $1 AND rail = 'more_like_this' AND hidden_at IS NULL`,
          [this.host.analysisId],
        );
        for (const row of rows) {
          const gone = retractedNames.get(row.subject_id);
          const match = row.style_match;
          if (!gone || !match || !match.claims.some((c) => gone.has(c.name))) continue;
          const claims = match.claims.filter((c) => !gone.has(c.name));
          const next: StyleMatch = { ...match, claims, palette: claims.some((c) => c.slot === 'aesthetics') ? match.palette : [] };
          if (!claims.length && match.via !== 'entity') {
            await tx.query(`UPDATE recommendations SET hidden_at = now(), style_match = $2::jsonb, reading_rev = $3 WHERE id = $1`, [row.id, JSON.stringify(next), this.stored!.rev]);
          } else {
            const reason = buildStyleReason({ claims, palette: next.palette, via: match.via === 'exemplar' ? 'overlap' : match.via, entityName: match.via_entity });
            await tx.query(`UPDATE recommendations SET display_reason = $2, style_match = $3::jsonb, reading_rev = $4 WHERE id = $1`, [row.id, reason, JSON.stringify(next), this.stored!.rev]);
          }
        }
      });
    }
    await this.trace('style:corroborate', totals);
    return totals;
  }
}
