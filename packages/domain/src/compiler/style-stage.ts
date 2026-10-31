import sharp from 'sharp';
import { createHash } from 'node:crypto';
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
  type ConnectionAssetProvider,
} from '@culture-atlas/providers';
import type { Category, ItemKind, SectionStatus } from '../enums';
import { LIMITS } from '../enums';
import { activeKills } from '../flags/feature-flags';
import type { JobContext } from '../jobs/handler';
import type { Queryable } from '../db/pool';
import type { Owner } from '../principal';
import { destinationFromQlooProperties, imageFromQlooProperties } from '../services/display';
import { admitDiscovery, discoveryReason, distinctiveDesignEvidence, proofIsActive, seedMatchesSubject, type CandidateProof, type DiscoverySeed } from '../style/discovery-evidence';
import { connectionEvidenceClass, selectEvidenceFirst } from '../style/discovery-selection';
import { planConnectionTopics, type ConnectionTopicPlan } from '../style/connection-topics';
import { bindSourceEvidence, compileSourceFeaturePlan, sameSourceEvidence } from '../style/source-feature-plan';
import { validateConnectionPublication } from '../style/connection-publication';
import { candidateAuditRecord } from '../style/candidate-audit';
import { selectExemplars } from '../style/exemplars';
import { acceptedTags, bestFilterTag, mapSubjectTags, primaryStyleTag, tagLookupQueries, type AcceptedTag } from '../style/map-tags';
import { computeSwatches, PALETTE_SIZE, paletteDecision, type Swatch } from '../style/palette';
import { buildStyleReason, type StyleMatch, type StyleMatchClaim } from '../style/reasons';
import { genreFilterFor, rankCatalogue, subjectProfile } from '../style/affinity';
import { echoNames } from '../style/affinity';
import { bridgeTargets } from '../style/adjacency';
import { type CrossDomainOptions, rerankCrossDomain, topicFilms } from '../style/cross-domain';
import { drinkKindOf, homeKindOf, homeMatch, homeRailCarry, homeVocabulary, rankHomeCatalogue, type HomeKind } from '../style/home-affinity';
import { lowerFirst } from '../style/text';
import { resolveTopicTags, topicTagPlan, type StyleTopicTag } from '../style/topic-tags';
import { rankAffinity, type AffinityCandidate } from '../style/affinity-rail';
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

type StyleJobContext = Pick<JobContext, 'db' | 'providers' | 'config' | 'signal' | 'trace' | 'runStage' | 'ensureActive' | 'job' | 'workerId'>;

export const FEATURE_BOUND_CONNECTION_COMPILER = 'compiler-2026-10-27-intent-quality-v10';

export interface ConnectionRetrievalPlan extends ConnectionTopicPlan {
  targetType: 'urn:entity:brand' | 'urn:entity:movie';
  tagQueries?: readonly string[];
  sourceFeatureIds?: readonly string[];
}

const FEATURE_QUERIES: Readonly<Record<string, readonly string[]>> = {
  stripes: ['striped', 'stripes'], colour_block: ['colorblock', 'color block'],
  rib_trim: ['ribbed trim', 'ribbed'], floral: ['floral', 'floral print'],
  sequins: ['sequins', 'sequined'], bow: ['bow', 'bows'],
  canopy: ['canopy', 'four poster'], bentwood: ['bentwood'],
  speckling: ['speckled', 'speckled glaze'], dipped_glaze: ['dipped glaze'],
};

/** Two source concepts total, with actual retained features taking precedence over broad topics. */
export function compileConnectionRetrievalPlans(subjects: readonly StoredSubject[], readingRev: number): ConnectionRetrievalPlan[] {
  const features = compileSourceFeaturePlan(subjects, readingRev).features;
  const bySubject = subjects.map((subject) => {
    const supported = features.filter((f) => f.subjectId === subject.id);
    const featurePlans: ConnectionRetrievalPlan[] = supported.flatMap((feature) => {
      const queries = FEATURE_QUERIES[feature.concept] ??
        (feature.kind === 'style_family' ? [feature.publicCue.toLowerCase()] : undefined);
      if (!queries || !['fashion', 'interior'].includes(subject.category)) return [];
      return [{ key: `feature:${feature.concept}`, subjectId: subject.id, claim: feature.claim,
        sourceCue: feature.publicCue, sourceFeatureIds: [feature.id], tagQuery: queries[0]!,
        tagQueries: queries.slice(0, 2), requiresDocumentary: false, targetType: 'urn:entity:brand' as const }];
    });
    const topics = planConnectionTopics([subject]).filter(() => supported.length > 0)
      .map((p) => ({ ...p, targetType: 'urn:entity:movie' as const }));
    return [...featurePlans, ...topics];
  });
  const out: ConnectionRetrievalPlan[] = [];
  for (const index of [0, 1]) for (const plans of bySubject) {
    const plan = plans[index];
    if (plan) out.push(plan);
    if (out.length === 2) return out;
  }
  return out;
}

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
  readonly compilerVersion?: string;
  readonly checkConnectionAsset?: ConnectionAssetProvider['checkConnectionAsset'];
  /** Private exact-parser replay only; off unless explicitly privacy-reviewed. */
  readonly retainPrivateConnectionContent?: boolean;
}

const PRIVATE_CONTENT_MAX = 4_000;
const SENSITIVE_PUBLIC_CONTENT = /https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:api[_ -]?key|authorization|bearer|password|secret|ssn|social security|date of birth|born on|home address|phone number)\b/i;

export function connectionContentForAdmission(entity: QlooEntity): QlooEntity {
  const properties = { ...entity.properties };
  for (const field of ['description', 'short_description'] as const) {
    const value = properties[field];
    if (typeof value === 'string' && (value.length > PRIVATE_CONTENT_MAX || SENSITIVE_PUBLIC_CONTENT.test(value))) delete properties[field];
  }
  return { ...entity, properties };
}

export function retainConnectionCandidateTags(proof: CandidateProof, entity: QlooEntity): CandidateProof {
  const tags = [...proof.candidateTags, ...(entity.tags ?? []).slice(0, 160).map((t) => ({ id: t.id, label: t.name }))];
  return { ...proof, candidateTags: tags.filter((t, index) => tags.findIndex((other) => other.id === t.id) === index) };
}

/** Only allowlisted public work fields; never opaque payloads, URLs or person records.
 * Omitted by default. Main must privacy-review the explicit opt-in before a paid run. */
export function retainedConnectionContent(entity: QlooEntity, enabled = false) {
  if (!enabled || !entity.types.some((t) => t === 'urn:entity:movie' || t === 'urn:entity:tv_show')) return undefined;
  const fields = Object.fromEntries((['description', 'short_description'] as const).flatMap((field) => {
    const value = entity.properties[field];
    if (typeof value !== 'string') return [];
    const rejectCode = SENSITIVE_PUBLIC_CONTENT.test(value) ? 'sensitive_pattern' : value.length > PRIVATE_CONTENT_MAX ? 'length' : null;
    return [[field, { characters: value.length, sha256: createHash('sha256').update(value).digest('hex'),
      reject_code: rejectCode, ...(rejectCode ? {} : { text: value }) }]];
  }));
  return { version: 'private_connection_public_work_content_v1' as const, fields };
}

export interface ConnectionPublicationCandidate {
  candidateId: string;
  name: string;
  actualTypes: readonly string[];
  imageUrl: string | null;
  proof: CandidateProof | null | undefined;
}

/** A revision changes only after the very same feature ids/observations rematch.
 * Changed, held, missing or retracted evidence is never repaired by relabeling. */
export function reconcileConnectionProof(proof: CandidateProof, subject: StoredSubject | undefined, readingRev: number): CandidateProof | null {
  if (!subject || !proof.sourceEvidence || !proofIsActive(proof, [subject])) return null;
  const expected = bindSourceEvidence(subject, proof.claim, readingRev);
  if (!expected || !sameSourceEvidence({ ...expected, readingRev: 0 }, { ...proof.sourceEvidence, readingRev: 0 })) return null;
  return { ...proof, readingRev, sourceEvidence: expected };
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
  /** The origin subject's category: only some subjects' bridges are real cross-domain adjacency (eval r3, cause 1). */
  subjectCategory: StoredSubject['category'];
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

/** Brand is an entity type, not proof of apparel. Home brands stay on their subject rail. */
export function styleRailCardKind(types: readonly string[], category?: StoredSubject['category']): { kind: ItemKind; category: Category | null } | null {
  if (types.includes('urn:entity:brand')) return { kind: 'brand', category: category === 'fashion' ? 'wear' : category === 'food' ? 'eat' : null };
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

/** Brand names the subject itself already surfaced: brand anchors, the read logo, the identified entity (echo keys). */
function subjectEchoNames(s: StoredSubject | null, anchors: readonly StyleAnchor[]): ReadonlySet<string> {
  const names = anchors.filter((a) => a.types.includes('urn:entity:brand')).map((a) => a.name);
  if (s?.brand?.name) names.push(s.brand.name);
  if (s?.entity?.name) names.push(s.entity.name);
  return echoNames(names);
}
/** TOPIC-1: Qloo theme tags on films per subject category (recorded: fixtures/qloo/probe-2026-10-24-tune). */
export interface StyleTopic {
  tagId: string;
  topic: string;
}
export interface ResolvedConnectionPlan {
  plan: ConnectionRetrievalPlan;
  topic: StyleTopicTag;
  documentaryTagId?: string;
  lookupQuery?: string;
}

/** Stable provider order within equivalent subject/concept diversity tiers. */
export function selectConnectionConcepts<T>(
  pool: readonly T[], slots: number, proofFor: (candidate: T) => CandidateProof | null | undefined,
  previous: readonly T[] = [],
  strengthFor: (candidate: T) => number = () => 0,
): T[] {
  const selected: T[] = [];
  const subjects = new Set<string>();
  const concepts = new Set<string>();
  const remember = (candidate: T) => {
    const p = proofFor(candidate);
    if (p?.subjectId) subjects.add(p.subjectId);
    if (p) concepts.add(p.contentEvidence?.topicPlanKey ?? `${p.relation}:${normalizeStyleName(p.claim.name)}`);
  };
  for (const candidate of previous) remember(candidate);
  const remaining = [...pool];
  while (selected.length < slots && remaining.length) {
    let best = 0;
    let bestTier = -1;
    for (let i = 0; i < remaining.length; i++) {
      const p = proofFor(remaining[i]!);
      const concept = p && (p.contentEvidence?.topicPlanKey ?? `${p.relation}:${normalizeStyleName(p.claim.name)}`);
      const tier = strengthFor(remaining[i]!) * 4 + Number(!!p?.subjectId && !subjects.has(p.subjectId)) * 2 + Number(!!concept && !concepts.has(concept));
      if (tier > bestTier) { best = i; bestTier = tier; }
    }
    const next = remaining.splice(best, 1)[0]!;
    selected.push(next);
    remember(next);
  }
  return selected;
}

/** Call only inside the shared capture publication fence: no parallel mutable counter. */
export async function connectionTasteSlots(db: Queryable, analysisId: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM recommendations WHERE analysis_id = $1 AND hidden_at IS NULL
       AND style_match->'discovery_proof'->>'relation' = 'qloo_taste'`, [analysisId],
  );
  return rows[0]?.count ? 0 : 1;
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
  private readonly subjectReady = deferred<void>();
  private readonly bridgeList: StyleBridge[] = [];
  private stored: StoredStyleReading | null = null;
  private status: StyleSectionStatus | 'running' | 'pending' = 'pending';
  private swatches: Swatch[] = [];
  private pixels: { data: Buffer; width: number; height: number; channels: number } | null = null;
  private earlyRail: Promise<void> | null = null;
  private readonly retrievals = new WeakMap<QlooEntity, { queryId: string; request: QlooInsightsRequest }>();
  private readonly seedEvidence = new Map<string, DiscoverySeed[]>();

  private registerSeeds(subject: StoredSubject, seeds: readonly { id: string; name: string }[]): void {
    for (const seed of seeds) {
      // The subject selected this seed; assigning its first aesthetic would
      // assert a more specific relationship than the ranking actually proved.
      const evidence: DiscoverySeed = { id: seed.id, name: seed.name, subjectId: subject.id };
      this.seedEvidence.set(seed.id, [...(this.seedEvidence.get(seed.id) ?? []).filter((s) => s.subjectId !== subject.id), evidence]);
    }
  }

  private candidateProof(subject: StoredSubject | undefined, entity: QlooEntity): CandidateProof | null {
    if (!subject) return null;
    const retrieval = this.retrievals.get(entity);
    if (!retrieval) return null;
    const { request, queryId } = retrieval;
    const seeds = (request.signalEntities ?? []).flatMap((id) => [
      ...(this.seedEvidence.get(id) ?? []),
      ...(subject.entity?.id === id && seedMatchesSubject(subject, subject.entity.types) ? [{ id, name: subject.entity.name, subjectId: subject.id }] : []),
    ]);
    const proof = admitDiscovery([subject], this.requiresConnectionPublication ? connectionContentForAdmission(entity) : entity, request.filterType, {
      readingRev: this.stored?.rev, queryId,
      taste: { queryId, requestSeedIds: request.signalEntities ?? [], seeds },
      ...(request.filterLocationQuery ? { place: { queryId, city: request.filterLocationQuery, requestType: request.filterType, filterTagIds: request.filterTags ?? [] } } : {}),
    });
    return proof && this.requiresConnectionPublication ? retainConnectionCandidateTags(proof, entity) : proof;
  }
  /** A scope-only or audience neighbour cannot become another subject-style bridge. */
  private candidateBridge(subject: StoredSubject, entity: QlooEntity): StyleBridge[] {
    const proof = this.requiresConnectionPublication ? this.validatedConnectionProofs.get(entity.entity_id) : this.candidateProof(subject, entity);
    if (!proof || connectionEvidenceClass(proof) !== 'distinctive_design') return [];
    return [{ entityId: entity.entity_id, name: entity.name, subjectId: subject.id, subjectCategory: subject.category, aesthetic: proof.claim.slot === 'aesthetics' ? proof.claim.name : null }];
  }

  /** A brand anchor's early insights results, kept for the fashion rail (smatch-1). */
  private earlyEntity: { entityId: string; name: string; entities: QlooEntity[]; providerQueryId: string; isReplay: boolean } | null = null;
  /** Subjects whose rail already holds an early entity call's cards (R-4). */
  private readonly earlyBySubject = new Map<string, { entityId: string; count: number }>();
  /** TOPIC-1 fill: the reading's own words resolved to genre/subgenre/theme tags, once per target type. */
  private readonly topicTagsByTarget = new Map<string, readonly StyleTopicTag[]>();
  private documentaryPlans: Promise<readonly ResolvedConnectionPlan[]> | undefined;
  private connectionLookupsDone = false;
  private readonly completedConnectionPlans = new Set<string>();
  private featureBoundCompiler = false;
  private readonly plannedTagLookups = new Map<string, Promise<Map<string, QlooTag[]>>>();
  private readonly tagTerminalStatuses = new Map<string, string>();
  private readonly connectionAssetChecks = new Map<string, Promise<CandidateProof['assetEvidence'] | null>>();
  private assetAttempts = 0;
  private publicationQueue: Promise<unknown> = Promise.resolve();
  private readonly validatedConnectionProofs = new Map<string, CandidateProof>();
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

  connectionEvidenceStrength(proof: CandidateProof | null | undefined): number {
    if (!this.requiresConnectionPublication || !proof) return 0;
    const ids = new Set(proof.sourceEvidence?.featureIds ?? []);
    const specific = compileSourceFeaturePlan(this.stored?.subjects ?? [], this.stored?.rev ?? 0).features
      .filter((f) => f.subjectId === proof.subjectId && f.kind !== 'object_form' &&
        (ids.has(f.id) || proof.candidateTags.some((tag) => distinctiveDesignEvidence(f.claim, tag)))).length;
    return specific * 10 + Number(proof.contentEvidence?.focus === 'central') * 2;
  }

  auditConnectionCandidate(entity: QlooEntity, index: number) {
    const content = retainedConnectionContent(entity, this.host.retainPrivateConnectionContent === true);
    return { ...candidateAuditRecord(entity, index), ...(content ? { private_public_work_content: content } : {}) };
  }

  orderConnectionCandidates<T>(pool: readonly T[], proofFor: (candidate: T) => CandidateProof | null | undefined): T[] {
    if (!this.requiresConnectionPublication) return [...pool];
    const priority = (candidate: T) => {
      const proof = proofFor(candidate);
      const kind = proof && connectionEvidenceClass(proof);
      return Number(kind === 'distinctive_design' || kind === 'substantive_content') * 1000 + this.connectionEvidenceStrength(proof);
    };
    return pool.map((value, index) => ({ value, index })).sort((a, b) => priority(b.value) - priority(a.value) || a.index - b.index).map((c) => c.value);
  }

  private publicationCandidate(entity: QlooEntity, proof: CandidateProof | undefined): ConnectionPublicationCandidate {
    return { candidateId: entity.entity_id, name: entity.name, actualTypes: entity.types,
      imageUrl: imageFromQlooProperties(entity.properties, entity.name)?.url ?? null, proof };
  }

  private async ensureConnectionReadingCurrent(readingRev: number): Promise<void> {
    const { ctx } = this.host;
    await ctx.ensureActive();
    if (ctx.signal.aborted || this.host.pastSoftDeadline() || this.stored?.rev !== readingRev) throw new Error('Connection reading inactive');
    const { rows } = await ctx.db.query(
      `SELECT c.id FROM captures c JOIN analyses a ON a.id=c.active_analysis_id
       WHERE c.id=$1 AND c.active_analysis_id=$2 AND c.deleted_at IS NULL
         AND (a.style_reading->>'rev')::int=$3
         AND c.owner_account_id IS NOT DISTINCT FROM $4::uuid
         AND c.owner_session_id IS NOT DISTINCT FROM $5::uuid`,
      [this.host.capture.id, this.host.analysisId, readingRev,
        this.host.owner.kind === 'account' ? this.host.owner.accountId : null,
        this.host.owner.kind === 'session' ? this.host.owner.sessionId : null],
    );
    if (!rows.length) throw new Error('Connection analysis inactive');
  }

  connectionPublicationEligible(candidate: ConnectionPublicationCandidate, origin: string): boolean {
    if (!this.requiresConnectionPublication) return true;
    const proof = candidate.proof;
    return validateConnectionPublication({
      proof, subject: this.stored?.subjects.find((s) => s.id === proof?.subjectId),
      readingRev: this.stored?.rev ?? 0, candidateId: candidate.candidateId,
      targetType: candidate.actualTypes.includes(proof?.targetType ?? '') ? proof!.targetType : null,
      imageUrl: candidate.imageUrl, origin,
    }).eligible;
  }

  /** All rails share this single-flight queue and durable provider allowance.
   * Check at most three candidates, NOT three successful candidates. */
  qualifyConnectionProofs(candidates: readonly ConnectionPublicationCandidate[], origin: string): Promise<ReadonlyMap<string, CandidateProof>> {
    const run = this.publicationQueue.then(() => this.qualifyConnectionProofsSerial(candidates, origin));
    this.publicationQueue = run.catch(() => undefined);
    return run;
  }

  private async qualifyConnectionProofsSerial(candidates: readonly ConnectionPublicationCandidate[], origin: string): Promise<ReadonlyMap<string, CandidateProof>> {
    if (!this.requiresConnectionPublication) return new Map(candidates.flatMap((c) => c.proof ? [[c.candidateId, c.proof] as const] : []));
    const eligible = new Map<string, CandidateProof>();
    const withheld: { candidate_id: string; reasons: readonly string[] }[] = [];
    const { ctx } = this.host;
    const revision = this.stored?.rev ?? 0;
    const readingSnapshot = JSON.stringify(this.stored);
    for (const candidate of candidates.slice(0, 100)) {
      const subject = this.stored?.subjects.find((s) => s.id === candidate.proof?.subjectId);
      const proof = candidate.proof && reconcileConnectionProof(candidate.proof, subject, revision);
      if (!proof) { withheld.push({ candidate_id: candidate.candidateId, reasons: ['source_feature_rematch_failed'] }); continue; }
      const input = { proof, subject, readingRev: revision, candidateId: candidate.candidateId,
        targetType: candidate.actualTypes.includes(proof.targetType ?? '') ? proof.targetType : null,
        imageUrl: candidate.imageUrl, origin };
      const preliminary = validateConnectionPublication({ ...input, proof: { ...proof, assetEvidence: undefined } });
      const sourceReasons = preliminary.reasons.filter((r) => !r.startsWith('asset_'));
      if (sourceReasons.length || !candidate.imageUrl || !/^https:\/\/[^/\s@]+(?:\/|$)/i.test(candidate.imageUrl)) {
        withheld.push({ candidate_id: candidate.candidateId, reasons: sourceReasons.length ? sourceReasons : ['asset_image_unavailable'] });
        continue;
      }
      // These are actual candidate tags, never a source label or inferred business identity.
      const typeScope = [...new Set([...candidate.actualTypes, ...proof.candidateTags.flatMap(t =>
        typeof t?.label === 'string' ? [t.label] : [])])]
        .filter(t => typeof t === 'string' && t.length > 0 && t.length <= 160 &&
          ![...t].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)).slice(0, 8);
      const metadata = { candidateId: candidate.candidateId, name: candidate.name, actualType: proof.targetType!, typeScope };
      const key = JSON.stringify([metadata, candidate.imageUrl]);
      let check = this.connectionAssetChecks.get(key);
      if (!check) {
        const checker = this.host.checkConnectionAsset ?? (ctx.providers.connectionAsset?.isConfigured()
          ? ctx.providers.connectionAsset.checkConnectionAsset.bind(ctx.providers.connectionAsset) : undefined);
        const limit = Math.min(3, Math.max(0, ctx.config.CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE ?? 0));
        if (!checker || limit === 0 || this.assetAttempts >= limit || this.host.owner.kind !== 'account' ||
            this.host.pastSoftDeadline() || ctx.signal.aborted) {
          withheld.push({ candidate_id: candidate.candidateId, reasons: [this.host.pastSoftDeadline() ? 'deadline' : !checker || limit === 0 ? 'asset_checker_unavailable' : 'asset_attempt_budget'] });
          continue;
        }
        this.assetAttempts++;
        check = (async () => {
          await this.ensureConnectionReadingCurrent(revision);
          const checkContext = {
            db: ctx.db, captureId: this.host.capture.id, analysisId: this.host.analysisId,
            readingSnapshot,
            accountId: this.host.owner.kind === 'account' ? this.host.owner.accountId : '',
            jobId: ctx.job.id, workerId: ctx.workerId, signal: ctx.signal,
            ensureActive: () => this.ensureConnectionReadingCurrent(revision),
            budget: this.host.callOptions('connections:asset').budget, traceId: this.host.traceId ?? undefined,
          };
          return checker(metadata, candidate.imageUrl!, checkContext);
        })().catch(() => null);
        this.connectionAssetChecks.set(key, check);
      }
      const assetEvidence = await check;
      // A failed current check must not inherit an older proof's asset verdict.
      const checked = { ...proof, assetEvidence: assetEvidence ?? undefined };
      const verdict = validateConnectionPublication({ ...input, proof: checked });
      if (verdict.eligible && !ctx.signal.aborted && this.stored?.rev === revision && !this.host.pastSoftDeadline()) eligible.set(candidate.candidateId, checked);
      else withheld.push({ candidate_id: candidate.candidateId, reasons: verdict.reasons.length ? verdict.reasons : ['reading_or_deadline_changed'] });
    }
    await this.trace('connections:publication_gate', { eligible: eligible.size, withheld: withheld.length,
      candidates: withheld.slice(0, 30), allocated_attempts_this_run: this.assetAttempts, empty: eligible.size === 0 });
    return eligible;
  }

  bridges(): StyleBridge[] {
    return [...this.bridgeList];
  }

  /**
   * Whether any subject's rails may bridge into a cross-domain category at all (eval r3, cause
   * 1). False once the reading exists and no subject category is bridge-eligible (interior, craft,
   * food and place photos bridge nowhere): the long no-anchor bridge wait is then pointless,
   * because their entertainment surface is the topic path, not a rail brand's co-likers. True
   * while the reading is still unknown.
   */
  get bridgeEligible(): boolean {
    const subjects = this.stored?.subjects;
    return !subjects || subjects.some((s) => bridgeTargets(s.category).length > 0);
  }

  /** R-5: resolves when the More-like-this primary returned, the style stage ended without rails, or `ms` passed. */
  async waitForBridges(ms: number): Promise<StyleBridge[]> {
    await within(this.primary.promise, ms);
    return this.bridges();
  }

  /** Cross-domain queries need the subject, not just an early reference or prefetch. */
  async waitForSubject(ms: number): Promise<void> {
    if (this.stored || !['pending', 'running'].includes(this.status)) return;
    await within(this.subjectReady.promise, Math.max(0, ms));
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
   * cinema" rises for the room or the dish it echoes. Drops a result only for a stated policy:
   * the reading is the only signal (`dropStyleless`, measured: a bodybuilding label for a tennis
   * court), or the card repeats an anchor brand beyond the echo cap (eval r3, cause 4) — an echo
   * is penalized first, so a genuinely best echo can still show once. Pure policy in
   * style/cross-domain.ts; this is the reading-bound wrapper.
   */
  rerankCrossDomain<T extends { entity_id: string; name?: string; tags?: { id: string; name: string }[] }>(
    entities: readonly T[],
    styleShare = 0.5,
    options: CrossDomainOptions = {},
  ): T[] {
    return rerankCrossDomain(this.stored?.subjects ?? [], entities, styleShare, options);
  }

  /**
   * TOPIC-1 films: only those whose own Qloo tags share a style claim with the reading ("Midcentury
   * modern", "Urban decay", "Ramen", "Cafe"), strongest first. A topic alone ("design") is not a
   * match: with no overlapping film the Watch rail stays empty rather than showing popular films
   * about something else. Pure policy in style/cross-domain.ts.
   */
  topicFilms<T extends { entity_id: string; tags?: { id: string; name: string }[] }>(entities: readonly T[]): T[] {
    return topicFilms(this.stored?.subjects ?? [], entities);
  }

  /** Original guarded subjects, never a first-subject category fallback. */
  get requiresConnectionPublication(): boolean {
    return this.featureBoundCompiler || this.host.compilerVersion === FEATURE_BOUND_CONNECTION_COMPILER;
  }

  connectionPlans(): readonly ConnectionRetrievalPlan[] {
    return this.requiresConnectionPublication
      ? compileConnectionRetrievalPlans(this.stored?.subjects ?? [], this.stored?.rev ?? 0)
      : planConnectionTopics(this.stored?.subjects ?? []).map((p) => ({ ...p, targetType: 'urn:entity:movie' }));
  }

  /** Prefer bounded source-content work to broad/weak calls; this is not extra budget. */
  get connectionRequestHeadroom(): number {
    const plans = this.connectionPlans().filter((p) => !this.completedConnectionPlans.has(`${p.subjectId}:${p.key}`));
    return plans.length + (this.connectionLookupsDone ? 0 : new Set(plans.flatMap((p) => (p.tagQueries ?? [p.tagQuery]).slice(0, 2))).size + Number(plans.some((p) => p.requiresDocumentary)));
  }

  completeConnectionPlan(key: string, subjectId?: string): void {
    for (const plan of this.connectionPlans().filter((p) => p.key === key && (!subjectId || p.subjectId === subjectId)))
      this.completedConnectionPlans.add(`${plan.subjectId}:${plan.key}`);
  }

  /** Single-flight, source-bound lookups: one shared genre and at most two exact topics. */
  documentaryPlansFor(): Promise<readonly ResolvedConnectionPlan[]> {
    // Do not memoize the still-running reader's absence.
    if (!this.stored) return Promise.resolve([]);
    return this.documentaryPlans ??= this.resolveDocumentaryPlans();
  }

  private async resolveDocumentaryPlans(): Promise<readonly ResolvedConnectionPlan[]> {
    if (this.requiresConnectionPublication) return this.resolveFeatureBoundPlans();
    const plans = this.connectionPlans();
    const queries = [...new Set([...plans.map((p) => p.tagQuery), ...(plans.some((p) => p.requiresDocumentary) ? ['documentary'] : [])])];
    const results = await this.lookupTags(queries, true);
    this.connectionLookupsDone = true;
    const movieTag = (t: QlooTag) => !t.parents?.some((p) => p.startsWith('urn:entity:')) || t.parents.includes('urn:entity:movie');
    const documentary = results.get('documentary')?.find((t) => /^urn:tag:genre(?::|$)/.test(t.id) && normalizeStyleName(t.name) === 'documentary' && movieTag(t));
    return plans.flatMap((plan): ResolvedConnectionPlan[] => {
      const content = results.get(plan.tagQuery)?.find((t) => /^urn:tag:(?:genre|subgenre|theme|keyword)(?::|$)/.test(t.id) && normalizeStyleName(t.name) === normalizeStyleName(plan.tagQuery) && movieTag(t));
      if (!content || (plan.requiresDocumentary && !documentary)) {
        this.completeConnectionPlan(plan.key);
        return [];
      }
      return [{ plan, topic: { tagId: content.id, name: content.name, label: plan.sourceCue, subjectId: plan.subjectId, popularity: content.popularity ?? 0 }, ...(plan.requiresDocumentary ? { documentaryTagId: documentary!.id } : {}) }];
    });
  }

  private plannedLookup(query: string, target: ConnectionRetrievalPlan['targetType']): Promise<Map<string, QlooTag[]>> {
    const key = `${target}:${query}`;
    let lookup = this.plannedTagLookups.get(key);
    if (!lookup) {
      lookup = this.lookupTags([query], true, target);
      this.plannedTagLookups.set(key, lookup);
    }
    return lookup;
  }

  private async resolveFeatureBoundPlans(): Promise<readonly ResolvedConnectionPlan[]> {
    const plans = this.connectionPlans();
    const out: ResolvedConnectionPlan[] = [];
    const genre = plans.some((p) => p.requiresDocumentary)
      ? (await this.plannedLookup('documentary', 'urn:entity:movie')).get('documentary')?.find((t) =>
        /^urn:tag:genre(?::|$)/.test(t.id) && normalizeStyleName(t.name) === 'documentary' && t.parents?.includes('urn:entity:movie'))
      : undefined;
    for (const plan of plans) {
      let resolved: ResolvedConnectionPlan | undefined;
      let terminal = 'no_compatible_tag';
      for (const query of [...new Set(plan.tagQueries ?? [plan.tagQuery])].slice(0, 2)) {
        const results = await this.plannedLookup(query, plan.targetType);
        const found = results.get(query)?.find((t) => /^urn:tag:/.test(t.id) &&
          (plan.targetType !== 'urn:entity:movie' || /^urn:tag:(?:genre|subgenre|theme|keyword)(?::|$)/.test(t.id)) &&
          normalizeStyleName(t.name) === normalizeStyleName(query) && t.parents?.includes(plan.targetType));
        terminal = this.tagTerminalStatuses.get(`${plan.targetType}:${query}`) ?? (results.get(query)?.length ? 'no_compatible_tag' : 'empty');
        if ((terminal === 'returned' || terminal === 'cached_hit') && !found) terminal = 'no_compatible_tag';
        if (found && plan.requiresDocumentary && !genre) terminal = 'missing_documentary_genre';
        if (!found || (plan.requiresDocumentary && !genre)) continue;
        resolved = { plan, lookupQuery: query,
          topic: { tagId: found.id, name: found.name, label: plan.sourceCue, subjectId: plan.subjectId, popularity: found.popularity ?? 0 },
          ...(plan.requiresDocumentary ? { documentaryTagId: genre!.id } : {}) };
        break;
      }
      if (resolved) out.push(resolved);
      else this.completeConnectionPlan(plan.key, plan.subjectId);
      await this.trace('connections:plan', {
        plan_key: plan.key, subject_id: plan.subjectId, target_type: plan.targetType,
        terminal_status: resolved ? 'resolved' : terminal, query_binding: resolved?.lookupQuery ?? (plan.tagQueries ?? [plan.tagQuery]).slice(0, 2),
        tag_id: resolved?.topic.tagId ?? null, documentary_tag_id: resolved?.documentaryTagId ?? null,
      });
    }
    this.connectionLookupsDone = true;
    return out;
  }

  async topicTagsFor(targetType: string): Promise<readonly StyleTopicTag[]> {
    if (!this.stored) return [];
    const cached = this.topicTagsByTarget.get(targetType);
    if (cached) return cached;
    const plan = topicTagPlan(this.stored.subjects, undefined, targetType);
    let out: readonly StyleTopicTag[] = [];
    if (plan.length) {
      const results = await this.lookupTags(plan.map((p) => p.query));
      out = resolveTopicTags(plan, results, targetType);
    }
    this.topicTagsByTarget.set(targetType, out);
    return out;
  }

  /** The style section for analyses where style does not run (examples, no role, kill switch, budget). */
  async publishOff(status: StyleSectionStatus, reason: string): Promise<void> {
    // A published reading is never taken down by a later failure (B.4).
    if (this.status === 'ready' && status === 'failed') return;
    this.status = status;
    await setAnalysisSection(this.host.ctx.db, this.host.analysisId, 'style', status);
    this.subjectReady.resolve();
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
    if (this.host.compilerVersion === undefined) {
      const { rows } = await ctx.db.query<{ compiler_version: string }>('SELECT compiler_version FROM analyses WHERE id = $1', [this.host.analysisId]);
      this.featureBoundCompiler = rows[0]?.compiler_version === FEATURE_BOUND_CONNECTION_COMPILER;
    }
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
      const present = new Set<number>();
      s.palette.forEach((p, i) => {
        const decision = px ? paletteDecision(px.data, px.width, px.height, px.channels, s.region, p, swatches, s.observations) : 'not_present';
        if (decision === 'supported') present.add(p.swatch);
        else dropped.push({ path: `subjects[${s.id}].palette[${i}]`, rule: `G-STYLE-PALETTE-${decision.toUpperCase()}` });
      });
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
    this.subjectReady.resolve();
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
    this.subjectReady.resolve();
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
  private async lookupTags(queries: readonly string[], documentary = false, targetType = 'urn:entity:movie'): Promise<Map<string, QlooTag[]>> {
    const { ctx } = this.host;
    const out = new Map<string, QlooTag[]>();
    const caps = ctx.providers.qloo.capability();
    // A broad ten-tag style lookup can be truncated before movie-compatible
    // keywords. Do not let that differently scoped cache answer this lookup.
    const tagTypes = documentary ? targetType === 'urn:entity:brand'
      ? ['urn:tag:aesthetic_property:qloo', 'urn:tag:fashion_segment:qloo', 'urn:tag:signature_piece:qloo', 'urn:tag:keyword:qloo']
      : ['urn:tag:genre:media', 'urn:tag:subgenre:qloo', 'urn:tag:theme:qloo', 'urn:tag:keyword:qloo'] : undefined;
    for (const query of queries.slice(0, STYLE_TAG_LOOKUPS_MAX)) {
      const { rows } = await ctx.db.query<{ results: { id: string; name: string; type: string; parents?: string[] }[] | null }>(
        `SELECT results FROM provider_queries
          WHERE provider = 'qloo' AND operation = 'style_tags' AND status IN ('ok', 'empty')
            AND sanitized_request->'query'->>'filter.query' = $1 AND cache_expiry > now()
            AND ($2::jsonb IS NULL OR (sanitized_request->'query'->'filter.tag.types' = $2::jsonb
              AND (sanitized_request->'query'->>'take')::int >= 30))
          ORDER BY retrieved_at DESC LIMIT 1`,
        [query, tagTypes ? JSON.stringify(tagTypes) : null],
      );
      if (rows[0]?.results) {
        out.set(query, rows[0].results);
        this.tagTerminalStatuses.set(`${targetType}:${query}`, 'cached_hit');
        if (this.requiresConnectionPublication) await this.trace('connections:lookup', { terminal_status: 'cached_hit', query_binding: { query, tagTypes, targetType }, returned_tag_ids: rows[0].results.slice(0, 30).map((t) => t.id) });
        continue;
      }
      const blocked = this.host.pastSoftDeadline() ? 'deadline' : !isUsable(caps.tags) ? 'unavailable'
        : this.host.budget.remaining('qloo') <= (documentary ? 0 : this.connectionRequestHeadroom) ? 'budget' : null;
      if (blocked) {
        this.tagTerminalStatuses.set(`${targetType}:${query}`, blocked);
        if (this.requiresConnectionPublication) await this.trace('connections:lookup', { terminal_status: blocked, query_binding: { query, tagTypes, targetType } });
        continue;
      }
      const counter = attemptCounter();
      try {
        const call = await this.host.qlooCall('style:tags', (o) => ctx.providers.qloo.lookupTags({ query, take: documentary ? 30 : 10, ...(tagTypes ? { tagTypes } : {}) }, { ...o, ...(documentary ? { maxRetries: 0 } : {}), onAttempt: counter.observer }));
        const res = call.value;
        out.set(query, res.data);
        this.tagTerminalStatuses.set(`${targetType}:${query}`, res.data.length ? 'returned' : 'empty');
        if (this.requiresConnectionPublication) await this.trace('connections:lookup', {
          terminal_status: res.data.length ? 'returned' : 'empty', query_binding: { query, tagTypes, targetType },
          returned_tag_ids: res.data.slice(0, 30).map((t) => t.id),
        });
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
          queryContext: { stage: 'style:tags', attempts: call.attempts, request_binding: { query, take: documentary ? 30 : 10, ...(tagTypes ? { tagTypes } : {}) } },
          traceId: this.host.traceId,
          cacheTtlSeconds: PROVIDER_CACHE_TTL_SECONDS,
        });
      } catch (err) {
        if (isProviderError(err) && err.kind === 'aborted') throw err;
        const e = errorSummary(err);
        this.tagTerminalStatuses.set(`${targetType}:${query}`, e.code === 'budget_exhausted' ? 'budget' : 'unavailable');
        if (this.requiresConnectionPublication) await this.trace('connections:lookup', {
          terminal_status: e.code === 'budget_exhausted' ? 'budget' : 'unavailable', error_code: e.code,
          query_binding: { query, tagTypes, targetType },
        });
        await recordProviderQuery(ctx.db, {
          parent: { analysisId: this.host.analysisId },
          provider: 'qloo',
          operation: 'style_tags',
          request: { query, take: documentary ? 30 : 10, ...(tagTypes ? { tagTypes } : {}) },
          status: 'error',
          errorCode: e.code,
          httpStatus: e.status,
          queryContext: { stage: 'style:tags', attempts: (err as { attempts?: number }).attempts ?? counter.count(), request_binding: { query, take: documentary ? 30 : 10, ...(tagTypes ? { tagTypes } : {}) } },
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
        ...(type === 'urn:entity:brand' ? { filterTagsOperator: 'union', filterTags: ['urn:tag:genre:brand:fashion'] } : {}),
        explainability: true,
        take: 20,
      };
      const res = await this.insights('style:mlt:early', request, false, { subjectId: 's1', recipe: 'early_entity' });
      if (!res) return;
      // Prefetch only, for every type. The active subject and its commercial/media
      // role are unknown until the guarded reading arrives.
      this.earlyEntity = { entityId: e.entityId, name: e.name, entities: res.entities, providerQueryId: res.providerQueryId, isReplay: res.isReplay };
    })().catch(() => undefined);
  }

  private async insights(
    stage: string,
    request: QlooInsightsRequest,
    tagOnly: boolean,
    context: Record<string, unknown>,
    sourceSpecific = false,
  ): Promise<{ entities: QlooEntity[]; providerQueryId: string; isReplay: boolean } | null> {
    const { ctx } = this.host;
    if (!isUsable(ctx.providers.qloo.capability().insights) || this.host.budget.remaining('qloo') <= (sourceSpecific ? 0 : this.connectionRequestHeadroom) || this.host.pastSoftDeadline()) {
      if (sourceSpecific) await this.trace('connections:retrieval', { terminal_status: this.host.pastSoftDeadline() ? 'deadline' : !isUsable(ctx.providers.qloo.capability().insights) ? 'unavailable' : 'budget', query_binding: request });
      return null;
    }
    const counter = attemptCounter();
    const started = Date.now();
    try {
      const call = await this.host.qlooCall(stage, (o) =>
        ctx.providers.qloo.insights(request, { ...o, ...(this.requiresConnectionPublication ? { maxRetries: 0 } : {}), ...(tagOnly ? { timeoutMs: TAG_ONLY_TIMEOUT_MS } : {}), onAttempt: counter.observer }),
      );
      const res = call.value;
      if (sourceSpecific) await this.trace('connections:retrieval', { terminal_status: res.data.entities.length ? 'returned' : 'empty', query_binding: request, ...context });
      const providerQueryId = await recordProviderQuery(ctx.db, {
        parent: { analysisId: this.host.analysisId },
        provider: 'qloo',
        operation: 'insights',
        request: res.request,
        results: res.data.entities.slice(0, 100).map((e, i) => this.auditConnectionCandidate(e, i)),
        status: res.data.entities.length ? 'ok' : 'empty',
        httpStatus: res.status,
        durationMs: res.duration_ms,
        isReplay: res.is_replay,
        queryContext: { stage, rail: 'more_like_this', attempts: call.attempts, ...context },
        traceId: this.host.traceId,
        cacheTtlSeconds: PROVIDER_CACHE_TTL_SECONDS,
      });
      for (const entity of res.data.entities) this.retrievals.set(entity, { queryId: providerQueryId, request });
      const subjectId = context.subject_id;
      const subject = this.stored?.subjects.find((s) => s.id === subjectId);
      const proofs = res.data.entities.map((e) => subject ? this.candidateProof(subject, e) : null);
      await this.trace('style:retrieval_admission', {
        query_id: providerQueryId, retrieval_count: res.data.entities.length,
        admission_status: subject ? 'evaluated' : 'held_until_subject',
        admitted_count: subject ? proofs.filter(Boolean).length : 0,
        rejected_count: subject ? proofs.filter((p) => !p).length : 0,
        held_count: subject ? 0 : res.data.entities.length,
        candidates: res.data.entities.slice(0, 30).map((e, i) => ({ candidate_id: e.entity_id, relation: proofs[i]?.relation ?? null, status: subject ? proofs[i] ? 'admitted' : 'rejected' : 'held' })),
      });
      return { entities: res.data.entities, providerQueryId, isReplay: res.is_replay };
    } catch (err) {
      if (isProviderError(err) && err.kind === 'aborted') throw err;
      const e = errorSummary(err);
      const attempts = (err as { attempts?: number }).attempts ?? counter.count();
      if (sourceSpecific) await this.trace('connections:retrieval', {
        terminal_status: e.code === 'budget_exhausted' ? 'budget' : 'unavailable', error_code: e.code,
        query_binding: request, ...context,
      });
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
    if (this.requiresConnectionPublication) await this.documentaryPlansFor();
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
    for (const s of stored.subjects.slice(0, LIMITS.styleSubjectsMax)) await this.buildSubjectRail(s, anchors, city);
  }

  private async buildSubjectRail(s: StoredSubject, anchors: readonly StyleAnchor[], city: string | null): Promise<void> {
    const { ctx } = this.host;
    const stored = this.stored!;
    const key = `more_like_this:${s.id}`;
    if (this.requiresConnectionPublication) {
      const plans = (await this.documentaryPlansFor()).filter((p) => p.plan.targetType === 'urn:entity:brand' && p.plan.subjectId === s.id);
      if (plans.length) return this.buildFeatureRail(s, plans);
    }
    if (s.category === 'fashion' && !this.earlyBySubject.get(s.id)?.count) return this.buildFashionRail(s, anchors);
    const interiorBrands = ctx.config.STYLE_INTERIOR_BRANDS === true;
    // The home kind the reading's words name (chair, bowl, room, espresso), for the brand rail.
    const homeKind: HomeKind | null = interiorBrands
      ? s.category === 'interior'
        ? homeKindOf(s)
        : s.category === 'food'
          ? drinkKindOf(s)
          : null
      : null;
    const anchorIds = new Set(anchors.map((a) => a.entityId));
    const homePool = homeKind ? rankHomeCatalogue(s, homeKind, { exclude: anchorIds, max: FASHION_EXEMPLARS }) : [];
    this.registerSeeds(s, homePool);
    const accepted = acceptedTags(s);
    const F = bestFilterTag(s);
    // Exemplars must carry the subject's primary style tag (F, else its strongest mapped aesthetic).
    const primaryTag = primaryStyleTag(s);
    const exemplars =
      s.category === 'fashion' && !s.entity && primaryTag
        ? selectExemplars(styleVocabulary().brands, accepted, primaryTag.id, { exclude: anchorIds })
        : homePool.map((x) => ({ id: x.id, name: x.name, score: x.score, popularity: 1, shared: [] as string[] }));
    const plan: RailPlan = planMoreLikeThis({
      subject: s,
      entity: s.entity,
      filterTag: F?.id ?? null,
      accepted,
      exemplars,
      city,
      interiorBrandsEnabled: interiorBrands,
      homeKind,
    });
    if (plan.recipe === 'interior_brand' || plan.recipe === 'coffee_brand') return this.buildHomeRail(s, anchors, plan, homeKind!);
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
    const clean = (list: readonly QlooEntity[], request: QlooInsightsRequest) =>
      list.filter((x) => this.candidateProof(s, x) && !anchorIds.has(x.entity_id) && !(request.filterLocationQuery || request.signalLocationQuery ? outsideCity(x, (request.filterLocationQuery ?? request.signalLocationQuery)!) : false));
    // With an early entity rail, the primary entity call already ran: the style-constrained call is the secondary.
    const primaryReq = early?.count && plan.recipe === 'fashion_entity' ? null : plan.primary;
    const prefetched = s.entity && this.earlyEntity?.entityId === s.entity.id && this.earlyEntity.entities.every((e) => e.types.includes(plan.primary!.filterType)) ? this.earlyEntity : null;
    const a = prefetched ?? (primaryReq ? await this.insights(`style:mlt:${s.id}`, primaryReq, plan.tagOnly, { subject_id: s.id, recipe: plan.recipe, list: 'primary' }) : null);
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
    const carries = (e: QlooEntity) => !!this.candidateProof(s, e);
    // Eval r3, relevance cause 1: an artwork media subject's own rail holds only entities that
    // reference the work (its words in the entity's own name, tags or properties) or are about art
    // itself — a blockbuster sharing nothing with the painting is not "more like this".
    const adjacent = (e: QlooEntity) => !!this.candidateProof(s, e);
    listA = listA.filter((e) => carries(e) && adjacent(e));
    // Bridges: the top 2 real results of an entity- or filter-backed call (never a tag-only call's top
    // results, never places: a stadium bridging into Wear gave sports merchandise in the live check).
    if (plan.bridgeable && listA.length && verdictA === 'ok') {
      const usable = dedupeByName(fuseRail(listA, [], accepted).filter((c) => this.candidateProof(s, c.entity) && !c.entity.types.includes('urn:entity:place')));
      this.bridgeList.push(...usable.flatMap((c) => this.candidateBridge(s, c.entity)).slice(0, 2));
    }
    if (a) {
      if (!this.requiresConnectionPublication) this.primary.resolve();
      this.mark(`rail_primary_${s.id}`);
    }
    // Too few on-style results without a filter: the secondary call is style-constrained by the primary
    // style tag itself (a deviation from C.2 rule 7 for "resembles" tags, recorded in docs/pipeline.md;
    // nothing is asserted to the user: reasons keep the "resembles" template).
    const styleConstrained: QlooInsightsRequest | null =
      needsStyle && !F && primaryTag && plan.primary ? { ...plan.primary, filterTagsOperator: 'union', filterTags: [primaryTag.id], filterPopularityMin: undefined } : null;
    const secondaryReq = early?.count && plan.recipe === 'fashion_entity' ? plan.primary : (styleConstrained ?? plan.secondary);
    let b: Awaited<ReturnType<StyleStage['insights']>> = null;
    if (secondaryReq && (listA.length < SECONDARY_BELOW || (early?.count && secondaryReq === plan.primary)))
      b = await this.insights(`style:mlt:${s.id}:b`, secondaryReq, false, { subject_id: s.id, recipe: plan.recipe, list: 'secondary' });
    let listB = b ? clean(b.entities, secondaryReq!).filter((e) => carries(e) && adjacent(e)) : [];
    const verdictB = b ? flatVerdict(secondaryReq!, listB, accepted) : 'ok';
    if (verdictB === 'flat_discarded') listB = [];
    let fused = fuseRail(listA, listB, accepted, { primary: weightA, secondary: verdictB === 'flat_kept' ? 0 : 0.6 });
    // Without an identified entity a card is "more like this" only through real style overlap (C.4):
    // a result sharing none of the subject's accepted tags is left out (empty beats junk).
    fused = fused.filter((c) => this.candidateProof(s, c.entity));
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
      echoNames: subjectEchoNames(s, anchors),
    });
    if (added && !this.timings.rail_first_cards) this.mark('rail_first_cards');
    await this.trace('style:rail', { subject: s.id, status: 'ready', cards: added + (early?.count ?? 0), verdict_a: verdictA, verdict_b: verdictB, timings: this.timings });
  }

  private readonly featureRetrievals = new Map<string, Promise<Awaited<ReturnType<StyleStage['insights']>>>>();

  private async buildFeatureRail(subject: StoredSubject, plans: readonly ResolvedConnectionPlan[]): Promise<void> {
    const candidates: RailCandidate[] = [];
    const queries: string[] = [];
    let replay = false;
    for (const resolved of plans) {
      const key = `${resolved.plan.subjectId}:${resolved.plan.key}`;
      let call = this.featureRetrievals.get(key);
      if (!call) {
        call = this.insights(`style:feature:${key}`, { filterType: 'urn:entity:brand',
          filterTags: [resolved.topic.tagId], filterTagsOperator: 'intersection', take: 20, explainability: false },
        false, { subject_id: subject.id, source_feature_ids: resolved.plan.sourceFeatureIds ?? [], topic_plan_key: resolved.plan.key }, true)
          .finally(() => this.completeConnectionPlan(resolved.plan.key, resolved.plan.subjectId));
        this.featureRetrievals.set(key, call);
      }
      const result = await call;
      if (!result) continue;
      queries.push(result.providerQueryId);
      replay ||= result.isReplay;
      for (const entity of result.entities) {
        if (!(entity.tags ?? []).some((t) => t.id === resolved.topic.tagId) || !this.candidateProof(subject, entity)) continue;
        if (!candidates.some((c) => c.entity.entity_id === entity.entity_id))
          candidates.push({ entity, sources: ['primary'], overlap: 1, score: 1 });
      }
    }
    // v10 bridges become usable only after source/asset validation and commit.
    // run() resolves the shared signal when all subject rails have finished.
    if (!this.requiresConnectionPublication) this.primary.resolve();
    if (!queries.length || !candidates.length) return this.railStatus(`more_like_this:${subject.id}`, 'empty', 'no_supported_feature_candidates');
    await this.publishRail(subject.id, candidates, acceptedTags(subject), { via: 'overlap', entityName: null,
      palette: [], providerQueryId: queries[0]!, providerQueryIds: queries, isReplay: replay,
      rev: this.stored!.rev, append: false });
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
    this.registerSeeds(s, pool.slice(0, FASHION_EXEMPLARS));
    const genre = genreFilterFor(q.kind);
    const filterTags = [genre ?? FASHION_BRAND_TAG];
    const signals = [...(brandAnchor ? [brandAnchor.entityId] : []), ...pool.slice(0, FASHION_EXEMPLARS).map((x) => x.id)];
    await this.trace('style:rail', { subject: s.id, recipe: 'fashion_affinity', kind: q.kind, tier: q.tier, regions: [...q.regions], genre, pool: pool.length, exemplars: signals.length });
    if (!signals.length) {
      await this.railStatus(key, 'empty', 'no_signal');
      return;
    }
    await this.railStatus(key, 'running', null);
    const reqA: QlooInsightsRequest = { filterType: 'urn:entity:brand', filterTags, filterTagsOperator: 'union', signalEntities: signals, explainability: true, take: FASHION_TASTE_TAKE };
    const reqB: QlooInsightsRequest | null = pool.length ? { filterType: 'urn:entity:brand', filterTagsOperator: 'union', filterTags: [FASHION_BRAND_TAG], filterResultsEntities: pool.map((x) => x.id), take: pool.length } : null;
    const [a, b] = await Promise.all([
      this.insights(`style:mlt:${s.id}`, reqA, false, { subject_id: s.id, recipe: 'fashion_affinity', list: 'taste' }),
      reqB ? this.insights(`style:mlt:${s.id}:pool`, reqB, false, { subject_id: s.id, recipe: 'fashion_affinity', list: 'pool' }) : Promise.resolve(null),
    ]);
    const early = brandAnchor && this.earlyEntity?.entityId === brandAnchor.entityId ? this.earlyEntity : null;
    if (a || b) {
      if (!this.requiresConnectionPublication) this.primary.resolve();
      this.mark(`rail_primary_${s.id}`);
    }
    const ranked = rankAffinity(
      q,
      [
        { list: a?.entities ?? [], prior: true, fromEntity: false },
        { list: early?.entities ?? [], prior: true, fromEntity: true },
        { list: b?.entities ?? [], prior: false, fromEntity: false },
      ],
      { exclude: anchorIds, entityLinked: !!brandAnchor, signalNames: new Map(pool.slice(0, FASHION_EXEMPLARS).map((x) => [x.id, x.name])), echoNames: subjectEchoNames(s, anchors), admit: (e) => !!this.candidateProof(s, e) },
    );
    ranked.candidates = ranked.candidates.filter((c) => this.candidateProof(s, c.entity));
    const providerQueryIds = [a?.providerQueryId, early?.providerQueryId, b?.providerQueryId].filter((x): x is string => !!x);
    if (!ranked.candidates.length || !providerQueryIds.length) {
      await this.railStatus(key, 'empty', a || b ? 'flat_or_empty' : 'qloo_unavailable');
      await this.trace('style:rail', { subject: s.id, status: 'empty', recipe: 'fashion_affinity', gated: ranked.gated });
      return;
    }
    // Bridges for cross-domain recommend (C.5): the three most on-style results, not Qloo's first two
    // (three average out one brand's audience: one bridge alone pulled a whole rail into its market).
    this.bridgeList.push(...ranked.candidates.filter((x) => !x.via).flatMap((c) => this.candidateBridge(s, c.entity)).slice(0, FASHION_BRIDGES));
    const added = await this.publishAffinityRail(s.id, ranked.candidates, {
      entityName: brandAnchor?.name ?? null,
      providerQueryIds,
      isReplay: (a?.isReplay ?? false) || (b?.isReplay ?? false) || (early?.isReplay ?? false),
      rev: stored.rev,
      echoNames: subjectEchoNames(s, anchors),
    });
    if (added && !this.timings.rail_first_cards) this.mark('rail_first_cards');
    await this.trace('style:rail', { subject: s.id, status: added ? 'ready' : 'empty', recipe: 'fashion_affinity', cards: added, gated: ranked.gated, timings: this.timings });
  }

  /**
   * Home-brand rail (R-9, home-brands-1): "more like this" for an interior object, a room or
   * a coffee drink. The reading's own words rank the harvested home-brand catalogue of the
   * subject's industry (furniture, tableware, kitchenware, decor, ceramics, interior design,
   * coffee); the top matches become entity SIGNALS for one industry-filtered, explainable
   * insights call (probe: entity signal + industry filter returns coherent design brands; a
   * tag-only signal returns junk). A result may only be a card when it itself belongs to the
   * depicted industry's catalogue (its own tags carry a recorded industry of the kind's family,
   * or its harvested catalogue row does) and its own product families are not a fashion house's
   * (eval r3 precision: the coffee-filtered pages return streetwear and bridal houses). What it
   * shares with the reading must be real evidence — not a compound product token ("cup" inside
   * "K-Cup Coffee Pods") and not the brand naming itself ("Café União" for a sugar house) — and
   * that evidence alone must clear the rail's own bar (empty beats junk). Every result is then
   * re-ranked by its OWN Qloo tags against the reading (smatch-1, no fashion gates); reasons
   * name the tag the result itself carries.
   */
  private async buildHomeRail(s: StoredSubject, anchors: readonly StyleAnchor[], plan: RailPlan, kind: HomeKind): Promise<void> {
    const stored = this.stored!;
    const key = `more_like_this:${s.id}`;
    const anchorIds = new Set(anchors.map((a) => a.entityId));
    const signals = (plan.primary?.signalEntities ?? []).length;
    await this.trace('style:rail', { subject: s.id, recipe: plan.recipe, signals, kind });
    if (!signals) {
      await this.railStatus(key, 'empty', plan.emptyReason);
      return;
    }
    await this.railStatus(key, 'running', null);
    const a = await this.insights(`style:mlt:${s.id}`, plan.primary!, false, { subject_id: s.id, recipe: plan.recipe, list: 'taste' });
    if (a) {
      if (!this.requiresConnectionPublication) this.primary.resolve();
      this.mark(`rail_primary_${s.id}`);
    }
    const q = subjectProfile(s);
    const admitted = (a?.entities ?? []).filter((e) => this.candidateProof(s, e));
    const carried = homeRailCarry(admitted, q, kind);
    const gated = { ...carried.gated, admission: (a?.entities.length ?? 0) - admitted.length };
    const ranked = rankAffinity(q, [{ list: carried.list, prior: true, fromEntity: false }], {
      exclude: anchorIds,
      fashion: false,
      v: homeVocabulary(),
      match: (e) => homeMatch(q, e),
      admit: (e) => !!this.candidateProof(s, e),
      echoNames: subjectEchoNames(s, anchors),
    });
    // Reasons, claims and ordering carry the real shared evidence only (K-Cup pods, brand-named
    // lines and fashion houses are gone before any of this is shown).
    const candidates = ranked.candidates.filter((c) => this.candidateProof(s, c.entity));
    const providerQueryIds = [a?.providerQueryId].filter((x): x is string => !!x);
    if (!candidates.length || !providerQueryIds.length) {
      await this.railStatus(key, 'empty', a ? 'flat_or_empty' : 'qloo_unavailable');
      await this.trace('style:rail', { subject: s.id, status: 'empty', recipe: plan.recipe, gated: { ...gated, ...ranked.gated } });
      return;
    }
    // Bridges for cross-domain recommend (C.5): the most on-style results, not Qloo's first.
    this.bridgeList.push(...candidates.filter((x) => !x.via).flatMap((c) => this.candidateBridge(s, c.entity)).slice(0, FASHION_BRIDGES));
    const added = await this.publishAffinityRail(s.id, candidates, {
      entityName: null,
      providerQueryIds,
      isReplay: a?.isReplay ?? false,
      rev: stored.rev,
      echoNames: subjectEchoNames(s, anchors),
    });
    if (added && !this.timings.rail_first_cards) this.mark('rail_first_cards');
    await this.trace('style:rail', { subject: s.id, status: added ? 'ready' : 'empty', recipe: plan.recipe, cards: added, gated: { ...gated, ...ranked.gated }, timings: this.timings });
  }

  /** Inserts affinity rail cards (rail = more_like_this) with their own reasons and style_match. */
  private async publishAffinityRail(
    subjectId: string,
    ranked: readonly AffinityCandidate[],
    o: { entityName: string | null; providerQueryIds: readonly string[]; isReplay: boolean; rev: number; echoNames?: ReadonlySet<string> },
  ): Promise<number> {
    const { ctx } = this.host;
    const excluded = await this.host.excludedKeys();
    const subject = this.stored?.subjects.find((s) => s.id === subjectId);
    const proofs = new Map(ranked.flatMap((c) => { const proof = this.candidateProof(subject, c.entity); return proof ? [[c.entity.entity_id, proof] as const] : []; }));
    await this.trace('style:admission', { subject: subjectId, retrieved: ranked.length, admitted: proofs.size, rejected: ranked.length - proofs.size, candidates: ranked.slice(0, 30).map((c) => ({ candidate_id: c.entity.entity_id, relation: proofs.get(c.entity.entity_id)?.relation ?? null, status: proofs.has(c.entity.entity_id) ? 'admitted' : 'rejected' })) });
    const rawPool = this.orderConnectionCandidates(ranked.filter((c) => proofs.has(c.entity.entity_id) && styleRailCardKind(c.entity.types, subject?.category) && !excluded.has(`qloo:${c.entity.entity_id}`) && !this.host.usedKeys.has(`qloo:${c.entity.entity_id}`)), (c) => proofs.get(c.entity.entity_id));
    const qualified = await this.qualifyConnectionProofs(rawPool.map((c) => this.publicationCandidate(c.entity, proofs.get(c.entity.entity_id))), o.isReplay ? 'replay' : 'qloo');
    const pool = rawPool.filter((c) => qualified.has(c.entity.entity_id));
    for (const [id, proof] of qualified) proofs.set(id, proof);
    const byId = new Map(pool.map((c) => [c.entity.entity_id, c]));
    const picked = selectEvidenceFirst<RailCandidate>(
      pool.map((c) => ({ entity: c.entity, sources: ['primary' as const], overlap: c.match.score, score: c.score })),
      (c) => proofs.get(c.entity.entity_id),
      (list, slots, previous) => selectRail(list, slots, o.echoNames ? { names: o.echoNames } : undefined, previous),
      LIMITS.moreLikeThisPerSubject,
      1,
    ).map((x) => byId.get(x.entity.entity_id)!);
    let added = 0;
    await publishForCapture(ctx.db, this.host.capture.id, ctx.ensureActive, async (tx, capture) => {
      if (this.requiresConnectionPublication && capture.active_analysis_id !== this.host.analysisId) throw new Error('Connection analysis replaced');
      let tasteSlots = await connectionTasteSlots(tx, this.host.analysisId);
      const { rows } = await tx.query<{ next: number }>(`SELECT COALESCE(MAX(rank), 999) + 1 AS next FROM recommendations WHERE analysis_id = $1 AND rail = 'more_like_this' AND subject_id = $2`, [this.host.analysisId, subjectId]);
      let rank = Math.max(1000, rows[0]?.next ?? 1000);
      for (const c of picked) {
        const e = c.entity;
        if (this.host.usedKeys.has(`qloo:${e.entity_id}`)) continue;
        const kc = styleRailCardKind(e.types, subject?.category)!;
        const proof = proofs.get(e.entity_id)!;
        if (!this.connectionPublicationEligible(this.publicationCandidate(e, proof), o.isReplay ? 'replay' : 'qloo')) continue;
        if (!proofIsActive(proof, this.stored?.subjects ?? [])) continue;
        const taste = connectionEvidenceClass(proof) === 'taste_exploration';
        if (taste && tasteSlots === 0) continue;
        const viaEntity = proof.relation === 'qloo_taste';
        const reason = discoveryReason(proof, e.types[0]!);
        const claims: StyleMatchClaim[] = proof.claim.slot === 'label' ? [] : [{ slot: proof.claim.slot as StyleMatchClaim['slot'], name: proof.claim.name, wording: proof.claim.wording, tag_id: proof.candidateTags[0]?.id ?? '' }];
        const match: StyleMatch = {
          subject_id: subjectId,
          discovery_proof: proof,
          claims,
          palette: [],
          via_entity: viaEntity ? proof.provenance!.seedNames.join(' and ') : null,
          via: viaEntity ? 'entity' : c.via ? 'exemplar' : 'overlap',
          rail: 'more_like_this',
          ...(this.requiresConnectionPublication ? { actual_candidate_types: [...e.types] } : {}),
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
          providerQueryIds: [this.retrievals.get(e)!.queryId],
          contributingReferenceIds: [],
        });
        await tx.query(`UPDATE recommendations SET rail = 'more_like_this', subject_id = $2, style_match = $3::jsonb, reading_rev = $4 WHERE id = $1`, [recId, subjectId, JSON.stringify(match), this.requiresConnectionPublication ? proof.readingRev : o.rev]);
        this.host.usedKeys.add(itemKey);
        if (this.requiresConnectionPublication) {
          this.validatedConnectionProofs.set(e.entity_id, proof);
          if (subject) this.bridgeList.push(...this.candidateBridge(subject, e).slice(0, 1));
        }
        if (taste) tasteSlots--;
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
      echoNames?: ReadonlySet<string>;
    },
  ): Promise<number> {
    const { ctx } = this.host;
    const excluded = await this.host.excludedKeys();
    const subject = this.stored?.subjects.find((s) => s.id === subjectId);
    const proofs = new Map(candidates.flatMap((c) => { const proof = this.candidateProof(subject, c.entity); return proof ? [[c.entity.entity_id, proof] as const] : []; }));
    await this.trace('style:admission', { subject: subjectId, retrieved: candidates.length, admitted: proofs.size, rejected: candidates.length - proofs.size, candidates: candidates.slice(0, 30).map((c) => ({ candidate_id: c.entity.entity_id, relation: proofs.get(c.entity.entity_id)?.relation ?? null, status: proofs.has(c.entity.entity_id) ? 'admitted' : 'rejected' })) });
    const rawPool = this.orderConnectionCandidates(candidates.filter((c) => proofs.has(c.entity.entity_id) && styleRailCardKind(c.entity.types, subject?.category) && !excluded.has(`qloo:${c.entity.entity_id}`) && !this.host.usedKeys.has(`qloo:${c.entity.entity_id}`)), (c) => proofs.get(c.entity.entity_id));
    const qualified = await this.qualifyConnectionProofs(rawPool.map((c) => this.publicationCandidate(c.entity, proofs.get(c.entity.entity_id))), o.isReplay ? 'replay' : 'qloo');
    const pool = rawPool.filter((c) => qualified.has(c.entity.entity_id));
    for (const [id, proof] of qualified) proofs.set(id, proof);
    const slots = LIMITS.moreLikeThisPerSubject - (o.existing ?? 0);
    const picked = selectEvidenceFirst(pool, (c) => proofs.get(c.entity.entity_id),
      (list, count, previous) => selectRail(list, count, o.echoNames ? { names: o.echoNames } : undefined, previous),
      slots, 1);
    let added = 0;
    await publishForCapture(ctx.db, this.host.capture.id, ctx.ensureActive, async (tx, capture) => {
      if (this.requiresConnectionPublication && capture.active_analysis_id !== this.host.analysisId) throw new Error('Connection analysis replaced');
      let tasteSlots = await connectionTasteSlots(tx, this.host.analysisId);
      const { rows } = await tx.query<{ next: number }>(`SELECT COALESCE(MAX(rank), 999) + 1 AS next FROM recommendations WHERE analysis_id = $1 AND rail = 'more_like_this' AND subject_id = $2`, [this.host.analysisId, subjectId]);
      let rank = Math.max(1000, rows[0]?.next ?? 1000);
      for (const c of picked) {
        const e = c.entity;
        if (this.host.usedKeys.has(`qloo:${e.entity_id}`)) continue;
        const kc = styleRailCardKind(e.types, subject?.category)!;
        const proof = proofs.get(e.entity_id)!;
        if (!this.connectionPublicationEligible(this.publicationCandidate(e, proof), o.isReplay ? 'replay' : 'qloo')) continue;
        if (!proofIsActive(proof, this.stored?.subjects ?? [])) continue;
        const taste = connectionEvidenceClass(proof) === 'taste_exploration';
        if (taste && tasteSlots === 0) continue;
        const claims: StyleMatchClaim[] = proof.claim.slot === 'label' ? [] : [{ slot: proof.claim.slot as StyleMatchClaim['slot'], name: proof.claim.name, wording: proof.claim.wording, tag_id: proof.candidateTags[0]?.id ?? '' }];
        const reason = discoveryReason(proof, e.types[0]!);
        const match: StyleMatch = { subject_id: subjectId, discovery_proof: proof, claims, palette: [], via_entity: proof.provenance?.seedNames.join(' and ') ?? null, via: proof.relation === 'qloo_taste' ? 'entity' : 'overlap', rail: 'more_like_this',
          ...(this.requiresConnectionPublication ? { actual_candidate_types: [...e.types] } : {}) };
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
          providerQueryIds: [this.retrievals.get(e)!.queryId],
          contributingReferenceIds: [],
        });
        await tx.query(`UPDATE recommendations SET rail = 'more_like_this', subject_id = $2, style_match = $3::jsonb, reading_rev = $4 WHERE id = $1`, [recId, subjectId, JSON.stringify(match), this.requiresConnectionPublication ? proof.readingRev : o.rev]);
        this.host.usedKeys.add(itemKey);
        if (this.requiresConnectionPublication) {
          this.validatedConnectionProofs.set(e.entity_id, proof);
          if (subject) this.bridgeList.push(...this.candidateBridge(subject, e).slice(0, 1));
        }
        if (taste) tasteSlots--;
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
    if (this.requiresConnectionPublication) {
      // Reconcile every current-revision proof, including wording-only changes.
      // Exact feature rematching is required; never attach a new revision alone.
      await publishForCapture(this.host.ctx.db, this.host.capture.id, this.host.ctx.ensureActive, async (tx, capture) => {
        if (capture.active_analysis_id !== this.host.analysisId) throw new Error('Connection analysis replaced');
        const { rows } = await tx.query<{
          id: string; candidate_id: string; origin: string; image_url: string | null;
          style_match: StyleMatch & { actual_candidate_types?: string[] };
        }>(
          `SELECT r.id,r.external_ids->>'qloo' AS candidate_id,r.origin,d.display_metadata->'image'->>'url' AS image_url,r.style_match
           FROM recommendations r JOIN discovery_items d ON d.id=r.discovery_item_id
           WHERE r.analysis_id=$1 AND r.rail IN ('more_like_this','cross_domain') AND r.hidden_at IS NULL`, [this.host.analysisId],
        );
        for (const row of rows) {
          const old = row.style_match?.discovery_proof;
          const subject = this.stored!.subjects.find((s) => s.id === old?.subjectId);
          const proof = old && reconcileConnectionProof(old, subject, this.stored!.rev);
          const verdict = validateConnectionPublication({ proof, subject, readingRev: this.stored!.rev,
            candidateId: row.candidate_id, targetType: row.style_match.actual_candidate_types?.includes(proof?.targetType ?? '') ? proof?.targetType : null,
            imageUrl: row.image_url, origin: row.origin });
          if (!proof || !verdict.eligible) {
            await tx.query('UPDATE recommendations SET hidden_at=now() WHERE id=$1', [row.id]);
            continue;
          }
          await tx.query('UPDATE recommendations SET style_match=$2::jsonb,reading_rev=$3 WHERE id=$1',
            [row.id, JSON.stringify({ ...row.style_match, discovery_proof: proof }), this.stored!.rev]);
        }
      });
      return totals;
    }
    // R-6: recompute reasons on the affected cards; hide those left without any overlap or entity.
    if (retractedNames.size) {
      const { ctx } = this.host;
      await publishForCapture(ctx.db, this.host.capture.id, ctx.ensureActive, async (tx) => {
        const { rows } = await tx.query<{ id: string; subject_id: string; style_match: StyleMatch | null }>(
          `SELECT id, subject_id, style_match FROM recommendations WHERE analysis_id = $1 AND rail IN ('more_like_this', 'cross_domain') AND hidden_at IS NULL`,
          [this.host.analysisId],
        );
        for (const row of rows) {
          const match = row.style_match;
          if (match?.discovery_proof) {
            const proof = match.discovery_proof;
            // Reference-only proofs have no subject claim for this style pass to retract.
            if (proof.subjectId === null) continue;
            const active = proofIsActive(proof, this.stored!.subjects);
            const target = proof.targetType ?? (proof.relation === 'brand_exploration' || proof.relation === 'shared_design' ? 'urn:entity:brand' : 'urn:entity:movie');
            await tx.query(`UPDATE recommendations SET hidden_at = CASE WHEN $2 THEN hidden_at ELSE now() END, display_reason = $3, reading_rev = $4 WHERE id = $1`, [row.id, active, discoveryReason(proof, target), this.stored!.rev]);
            continue;
          }
          const gone = retractedNames.get(row.subject_id);
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
