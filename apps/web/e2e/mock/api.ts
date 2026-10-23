/**
 * Stateful in-memory mock of the REST /v1 API for browser tests, installed
 * with Playwright route interception. Every response is validated against the
 * shared route contract (ROUTES) so the UI is exercised against the real
 * schemas while the API is built in parallel. Not a provider simulation: data
 * comes from e2e/mock/data.ts.
 */
import type { Page, Route } from '@playwright/test';
import { ROUTES, type RouteName } from '@culture-atlas/domain/schemas';
import type {
  AgentConnectionDto,
  CaptureResponse,
  CollectionMember,
  CollectionSummary,
  DiscoveryCard,
  Focus,
  JobResponse,
  MusicPick,
  PlanResponse,
  PlanVersionDto,
  ReferenceSummary,
  SensorConnectionDto,
} from '@culture-atlas/domain/schemas';
import { CAPTURE_RECS, FEED_SEED, resetIds, SAMPLE_CAPTURES, uid, type SeedItem } from './data';
import { OnboardingMock, type OnboardingMockOptions } from './onboarding';

export interface MockOptions {
  /** Start signed in (account) instead of as an anonymous visitor. */
  account?: boolean;
  /** Seed three collections plus unfiled saves (requires account). */
  seedCollections?: boolean;
  /** Seed one empty collection. */
  emptyCollection?: boolean;
  /** Related-discovery categories (play, watch) are unavailable: partial results + retry. */
  qlooUnavailable?: boolean;
  /** Analyses find no useful subject. */
  noSubject?: boolean;
  /** Ask "What caught your eye?" on analyses. */
  question?: boolean;
  /** Jobs never finish (to capture processing states). */
  holdJobs?: boolean;
  /** Polls before a job completes (default 2). */
  pollsToComplete?: number;
  /** Seed a World Sensor connection that is offline. */
  sensorOffline?: boolean;
  /** Seed an existing plan. */
  seedPlan?: boolean;
  /** Amendment 2.2 taste onboarding (questionnaire, seed job, Settings → Taste). */
  onboarding?: OnboardingMockOptions;
  /** A new account created in this session owes the questionnaire (default true). */
  onboardingOnSignUp?: boolean;
  /** The feed is the account's personal snapshot (not the labeled example feed). */
  personalFeed?: boolean;
}

interface JobRecord {
  id: string;
  type: JobResponse['type'];
  polls: number;
  state: JobResponse['state'];
  result: JobResponse['result'];
  onComplete?: () => void;
  created_at: string;
  sections: JobResponse['sections'];
}

interface CaptureRecord {
  id: string;
  itemId: string;
  source: CaptureResponse['source'];
  image: CaptureResponse['image'];
  focus: Focus;
  sample: string | null;
  version: number;
  ready: boolean;
  jobId: string | null;
  recs: string[];
  references: ReferenceSummary[];
  sections: NonNullable<CaptureResponse['analysis']>['sections'];
  title: string;
  interpretation: string;
}

interface CollectionRecord {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  members: Array<{ membership_id: string; item_id: string; added_at: string }>;
}

const now = () => new Date().toISOString();

export interface RequestLogEntry {
  method: string;
  path: string;
  search: string;
}

export class MockApi {
  readonly log: RequestLogEntry[] = [];
  readonly opts: MockOptions;
  session = {
    kind: 'anonymous' as 'anonymous' | 'account',
    account_id: null as string | null,
    session_id: uid(),
    csrf: 'csrf-' + uid(),
  };
  cards = new Map<string, DiscoveryCard>();
  seeds = new Map<string, SeedItem>();
  feedIds: string[] = [];
  saved = new Map<string, { saved_item_id: string; saved_at: string }>();
  hidden = new Set<string>();
  related = new Map<string, string[]>();
  jobs = new Map<string, JobRecord>();
  captures = new Map<string, CaptureRecord>();
  collections = new Map<string, CollectionRecord>();
  plans = new Map<string, PlanResponse>();
  agents: AgentConnectionDto[] = [];
  sensors: SensorConnectionDto[] = [];
  referenceId = uid();
  failures = new Map<string, { status: number; code: string; message: string }>();
  onboarding: OnboardingMock;

  constructor(opts: MockOptions = {}) {
    resetIds();
    this.opts = opts;
    this.onboarding = new OnboardingMock(opts.onboarding);
    this.referenceId = uid();
    for (const seed of FEED_SEED) {
      const card = this.addCard(seed, !opts.personalFeed);
      this.feedIds.push(card.id);
    }
    // Related: next three feed items.
    this.feedIds.forEach((id, i) =>
      this.related.set(
        id,
        [1, 2, 3].map((d) => this.feedIds[(i + d) % this.feedIds.length]!),
      ),
    );
    if (opts.account) this.session = { ...this.session, kind: 'account', account_id: uid() };
    if (opts.seedCollections) this.seedCollections();
    if (opts.emptyCollection) this.createCollection('Weekend ideas', null);
    if (opts.sensorOffline) {
      const past = new Date(Date.now() - 3 * 3600_000).toISOString();
      this.sensors.push({
        id: uid(),
        origin: 'https://relay.example',
        mode: 'bridge',
        enabled: true,
        last_success_at: past,
        last_attempt_at: now(),
        last_error_code: 'relay_unreachable',
        created_at: past,
      });
    }
    if (opts.seedPlan) this.seedPlan();
  }

  // ---- helpers -------------------------------------------------------------

  addCard(seed: SeedItem, isExample: boolean): DiscoveryCard {
    const id = uid();
    const card: DiscoveryCard = {
      id,
      kind: seed.kind,
      category: seed.category,
      title: seed.title,
      subtitle: seed.subtitle ?? null,
      image: seed.image ? { url: seed.image, width: 1000, height: 1250, alt: seed.title } : null,
      is_example: isExample,
      saved: false,
      saved_item_id: null,
      recommendation_id: null,
      evidence_available: true,
    };
    this.cards.set(id, card);
    this.seeds.set(id, seed);
    return card;
  }

  card(id: string): DiscoveryCard {
    const c = this.cards.get(id)!;
    const s = this.saved.get(id);
    return { ...c, saved: Boolean(s), saved_item_id: s?.saved_item_id ?? null };
  }

  feedCard(key: string): DiscoveryCard {
    const id = [...this.seeds.entries()].find(([, s]) => s.key === key)![0];
    return this.card(id);
  }

  save(itemId: string) {
    if (!this.saved.has(itemId)) this.saved.set(itemId, { saved_item_id: uid(), saved_at: now() });
    return this.saved.get(itemId)!;
  }

  createCollection(name: string, description: string | null) {
    const c: CollectionRecord = {
      id: uid(),
      name,
      description,
      revision: 1,
      created_at: now(),
      updated_at: now(),
      members: [],
    };
    this.collections.set(c.id, c);
    return c;
  }

  addMember(c: CollectionRecord, itemId: string) {
    const savedNow = !this.saved.has(itemId);
    this.save(itemId);
    const existing = c.members.find((m) => m.item_id === itemId);
    if (existing) return { created: false, saved: false, membership_id: existing.membership_id };
    const m = { membership_id: uid(), item_id: itemId, added_at: now() };
    c.members.push(m);
    c.revision += 1;
    c.updated_at = now();
    return { created: true, saved: savedNow, membership_id: m.membership_id };
  }

  seedCollections() {
    const slow = this.createCollection(
      'Slow Sunday',
      'A little music, a little cinema, something good to eat.',
    );
    for (const k of [
      'quiet-corners',
      'sunday-listening',
      'late-night-cinema',
      'something-to-share',
      'vintage-racing',
      'tea-rituals',
      'night-on-film',
      'bill-evans',
    ])
      this.addMember(slow, this.feedCard(k).id);
    const dark = this.createCollection('After dark', null);
    for (const k of ['night-wanderings', 'late-night-cinema', 'sunday-listening', 'nina-simone'])
      this.addMember(dark, this.feedCard(k).id);
    const everyday = this.createCollection('Everyday favorites', null);
    for (const k of ['linen-days', 'sculptural-forms', 'tea-rituals', 'a-softer-silhouette'])
      this.addMember(everyday, this.feedCard(k).id);
    for (const k of ['spring-light', 'cucumber-salad']) this.save(this.feedCard(k).id);
    // Make Slow Sunday the most recently updated.
    slow.updated_at = new Date(Date.now() + 1000).toISOString();
  }

  collectionSummary(c: CollectionRecord): CollectionSummary {
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      item_count: c.members.length,
      cover: c.members
        .map((m) => this.cards.get(m.item_id)?.image)
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .slice(0, 4),
      revision: c.revision,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  unfiledIds(): string[] {
    const filed = new Set(
      [...this.collections.values()].flatMap((c) => c.members.map((m) => m.item_id)),
    );
    return [...this.saved.keys()].filter((id) => !filed.has(id));
  }

  newJob(
    type: JobRecord['type'],
    result: JobRecord['result'],
    onComplete?: () => void,
    sections: JobRecord['sections'] = [],
  ): JobRecord {
    const job: JobRecord = {
      id: uid(),
      type,
      polls: 0,
      state: 'queued',
      result,
      onComplete,
      created_at: now(),
      sections,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  advance(job: JobRecord) {
    if (job.state !== 'queued' && job.state !== 'running') return;
    job.polls += 1;
    if (this.opts.holdJobs) {
      job.state = 'running';
      return;
    }
    if (job.polls >= (this.opts.pollsToComplete ?? 2)) {
      job.onComplete?.();
      job.state =
        this.opts.qlooUnavailable && job.type === 'analyze_capture' ? 'partial' : 'complete';
    } else job.state = 'running';
  }

  jobDto(job: JobRecord): JobResponse {
    const active = job.state === 'queued' || job.state === 'running';
    return {
      id: job.id,
      type: job.type,
      state: job.state,
      stage: active ? 'observing' : null,
      sections: job.sections,
      error:
        job.state === 'failed'
          ? {
              code: 'service_unavailable',
              message: 'The service is temporarily unavailable.',
              retryable: true,
            }
          : null,
      result: job.result,
      poll_after_ms: active ? 300 : null,
      created_at: job.created_at,
      updated_at: now(),
    };
  }

  // ---- captures ------------------------------------------------------------

  createCapture(sample: string | null, source: CaptureResponse['source']) {
    const s = sample ? SAMPLE_CAPTURES[sample] : null;
    const capture: CaptureRecord = {
      id: uid(),
      itemId: '',
      source,
      image: {
        url: s?.image ?? '/samples/outfit.jpg',
        width: 1000,
        height: 1250,
        alt: s?.alt ?? 'Your photo',
      },
      focus: { kind: 'whole' },
      sample,
      version: 0,
      ready: false,
      jobId: null,
      recs: [],
      references: [],
      sections: {},
      title: s?.title ?? 'Vintage racing',
      interpretation: s?.interpretation ?? 'A few vintage racing references stood out.',
    };
    const own = this.addCard(
      {
        key: `capture-${capture.id}`,
        title: capture.title,
        kind: 'capture',
        category: null,
        image: capture.image!.url,
        reason: capture.interpretation,
      },
      Boolean(sample),
    );
    capture.itemId = own.id;
    this.captures.set(capture.id, capture);
    this.analyze(capture);
    return capture;
  }

  analyze(capture: CaptureRecord) {
    const job = this.newJob('analyze_capture', { type: 'capture', id: capture.id }, () => {
      capture.ready = true;
      capture.version += 1;
      const unavailable = new Set(this.opts.qlooUnavailable ? ['play', 'watch'] : []);
      capture.sections = { observations: 'complete', references: 'complete', research: 'complete' };
      const recs: string[] = [];
      if (!this.opts.noSubject) {
        for (const cat of ['wear', 'play', 'watch', 'eat'] as const) {
          capture.sections[cat] = unavailable.has(cat) ? 'unavailable' : 'complete';
          if (unavailable.has(cat)) continue;
          for (const seed of CAPTURE_RECS[cat]) {
            const card = this.addCard(seed, Boolean(capture.sample));
            this.cards.set(card.id, { ...card, recommendation_id: uid() });
            recs.push(card.id);
          }
        }
      } else {
        for (const cat of ['wear', 'play', 'watch', 'eat'] as const)
          capture.sections[cat] = 'complete';
      }
      // Interleave categories for a mixed grid.
      const byCat = (c: string) => recs.filter((id) => this.cards.get(id)!.category === c);
      const mixed: string[] = [];
      for (let i = 0; i < 3; i++)
        for (const c of ['wear', 'play', 'watch', 'eat']) if (byCat(c)[i]) mixed.push(byCat(c)[i]!);
      capture.recs = mixed;
      capture.references = this.opts.noSubject
        ? []
        : [
            {
              id: this.referenceId,
              name: 'Endurance racing jackets',
              type: 'style',
              relation: 'resembles',
              qualified: true,
              has_page: true,
            },
            {
              id: uid(),
              name: 'Gulf racing livery',
              type: 'brand',
              relation: 'resembles',
              qualified: true,
              has_page: false,
            },
            {
              id: uid(),
              name: 'Motorsport',
              type: 'tradition',
              relation: 'depicted',
              qualified: false,
              has_page: false,
            },
          ];
    });
    capture.jobId = job.id;
    return job;
  }

  captureDto(c: CaptureRecord): CaptureResponse {
    const job = c.jobId ? this.jobs.get(c.jobId) : null;
    const active = job && (job.state === 'queued' || job.state === 'running');
    const recs = c.recs.filter((id) => !this.hidden.has(id)).map((id) => this.card(id));
    return {
      id: c.id,
      source: c.source,
      status: c.ready ? (this.opts.qlooUnavailable ? 'partial' : 'ready') : 'processing',
      received_at: now(),
      captured_at: null,
      image: c.image,
      focus: c.focus,
      is_example: Boolean(c.sample),
      discovery_item_id: c.itemId,
      saved: this.saved.has(c.itemId),
      analysis: c.ready
        ? {
            id: uid(),
            version: c.version,
            title: this.opts.noSubject ? 'Your photo' : c.title,
            interpretation: this.opts.noSubject ? null : c.interpretation,
            sections: c.sections,
            question: this.opts.question
              ? {
                  prompt: 'What caught your eye?',
                  choices: [
                    { id: 'jacket', label: 'The jacket' },
                    { id: 'chair', label: 'The chair' },
                  ],
                  whole_photo_choice_id: 'whole',
                }
              : null,
            warnings: this.opts.noSubject
              ? [{ code: 'no_useful_subject', message: 'No clear subject' }]
              : [],
            created_at: now(),
          }
        : null,
      references: c.ready ? c.references : [],
      recommendations: recs,
      available_categories: (['wear', 'play', 'watch', 'eat'] as const).filter((cat) =>
        recs.some((r) => r.category === cat),
      ),
      job_id: active ? job!.id : null,
    };
  }

  // ---- plans -----------------------------------------------------------------

  planVersion(plan: PlanResponse, version: number, music?: MusicPick[]): PlanVersionDto {
    const pick = (key: string) => this.feedCard(key);
    const night = pick('night-on-film');
    const music0: MusicPick[] = music ?? [
      {
        item_id: pick('bill-evans').id,
        kind: 'artist',
        title: 'Bill Evans',
        artist: null,
        image: null,
        reason: 'Quiet piano for the opening.',
        verified: false,
        destination_url: null,
        is_example: false,
      },
      {
        item_id: pick('nina-simone').id,
        kind: 'artist',
        title: 'Nina Simone',
        artist: null,
        image: null,
        reason: null,
        verified: false,
        destination_url: null,
        is_example: false,
      },
      {
        item_id: null,
        kind: 'artist',
        title: 'Chet Baker',
        artist: null,
        image: null,
        reason: null,
        verified: false,
        destination_url: null,
        is_example: false,
      },
    ];
    return {
      version,
      title: 'Your slow Sunday, planned.',
      summary: 'A film, a few dishes, and music to settle into.',
      sections: { film: 'complete', food: 'complete', music: 'complete' },
      film: {
        feature: {
          item_id: night.id,
          title: 'In the Mood for Love',
          year: 2000,
          image: {
            url: '/samples/feed/rainy-alley.jpg',
            width: 1000,
            height: 1250,
            alt: 'A lantern-lit alley at night',
          },
          reason: 'Lantern-lit evenings and unhurried longing.',
          destination_url: null,
          is_fixed: false,
          is_example: false,
        },
        alternates: [
          {
            item_id: pick('late-night-cinema').id,
            title: 'Chungking Express',
            year: 1994,
            image: null,
            reason: null,
            destination_url: null,
            is_fixed: false,
            is_example: false,
          },
          {
            item_id: pick('night-wanderings').id,
            title: 'Paterson',
            year: 2016,
            image: null,
            reason: null,
            destination_url: null,
            is_fixed: false,
            is_example: false,
          },
        ],
      },
      food: {
        dishes: [
          {
            item_id: pick('sesame-noodles').id,
            title: 'Sesame noodles',
            description: 'Cold noodles with sesame and scallion.',
            cuisine: 'Chinese-inspired',
            reason: null,
            image: { url: '/samples/feed/sesame-noodles.jpg', width: 1000, height: 1250, alt: '' },
            is_example: false,
          },
          {
            item_id: pick('cucumber-salad').id,
            title: 'Cucumber salad',
            description: 'Smashed cucumber with garlic and vinegar.',
            cuisine: 'Chinese-inspired',
            reason: null,
            image: { url: '/samples/feed/cucumber-salad.jpg', width: 1000, height: 1250, alt: '' },
            is_example: false,
          },
        ],
      },
      music: { before: music0, after: [] },
      rationale:
        'The film anchors the evening; the dishes and music keep its slow, warm pace. Mixing these influences is a creative choice, not a historical link.',
      inputs: plan.selected_item_ids.map((id, i) => ({
        item_id: id,
        title: this.cards.get(id)?.title ?? 'Item',
        kind: this.cards.get(id)?.kind ?? 'style',
        contribution: i === 0 ? 'strong' : i === 1 ? 'strong' : 'weak',
        note: i > 1 ? 'Lent its mood more than its subject.' : null,
      })),
      collection_revision: 3,
      created_at: now(),
    };
  }

  createPlan(
    collectionId: string | null,
    itemIds: string[],
    exploration: PlanResponse['exploration'],
    constraints: PlanResponse['constraints'],
  ) {
    const plan: PlanResponse = {
      id: uid(),
      template: 'movie_night',
      status: 'queued',
      source_collection_id: collectionId,
      selected_item_ids: itemIds,
      fixed_film_item_id: null,
      constraints,
      exploration,
      active_version: null,
      versions: [],
      job_id: null,
      created_at: now(),
      updated_at: now(),
    };
    this.plans.set(plan.id, plan);
    const job = this.newJob('generate_plan', { type: 'plan', id: plan.id }, () => {
      plan.status = 'complete';
      plan.active_version = this.planVersion(plan, 1);
      plan.versions = [{ version: 1, created_at: now() }];
      plan.job_id = null;
    });
    plan.job_id = job.id;
    return { plan, job };
  }

  seedPlan() {
    const slow = [...this.collections.values()].find((c) => c.name === 'Slow Sunday');
    const items = slow ? slow.members.slice(0, 3).map((m) => m.item_id) : this.feedIds.slice(0, 3);
    const { plan, job } = this.createPlan(slow?.id ?? null, items, 'balanced', {});
    job.onComplete?.();
    job.state = 'complete';
    plan.job_id = null;
  }

  // ---- routing ----------------------------------------------------------------

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    this.log.push({ method, path: url.pathname, search: url.search });
    const match = this.match(method, url.pathname);
    if (!match)
      return route.fulfill({
        status: 404,
        json: { code: 'not_found', message: 'Not found.', retryable: false, request_id: 'mock' },
      });
    const [name, params] = match;
    const failure = this.failures.get(name);
    if (failure)
      return route.fulfill({
        status: failure.status,
        json: {
          code: failure.code,
          message: failure.message,
          retryable: false,
          request_id: 'mock',
        },
      });
    if (method !== 'GET' && req.headers()['x-csrf-token'] !== this.session.csrf) {
      return route.fulfill({
        status: 403,
        json: {
          code: 'csrf_failed',
          message: 'The request could not be verified. Refresh and try again.',
          retryable: false,
          request_id: 'mock',
        },
      });
    }
    const contentType = req.headers()['content-type'] ?? '';
    let body: unknown = undefined;
    if (contentType.includes('application/json')) body = req.postDataJSON();
    const contract = ROUTES[name];
    if (
      body !== undefined &&
      'body' in contract &&
      contract.body &&
      typeof contract.body !== 'string'
    ) {
      const parsed = contract.body.safeParse(body);
      if (!parsed.success)
        return route.fulfill({
          status: 400,
          json: {
            code: 'invalid_input',
            message: 'The request is not valid.',
            retryable: false,
            request_id: 'mock',
            details: parsed.error.issues,
          },
        });
      body = parsed.data;
    }
    const result = this.dispatch(name, params, url.searchParams, body, {
      multipart: contentType.startsWith('multipart/form-data'),
      raw: req.postDataBuffer(),
    });
    if ('error' in result)
      return route.fulfill({
        status: result.status,
        json: { code: result.error, message: result.message, retryable: false, request_id: 'mock' },
      });
    const status = result.status ?? contract.status;
    if (contract.response === null || status === 204) return route.fulfill({ status: 204 });
    const check = contract.response.safeParse(result.json);
    if (!check.success) {
      throw new Error(
        `Mock response for ${name} violates the contract: ${JSON.stringify(check.error.issues.slice(0, 3))}`,
      );
    }
    return route.fulfill({
      status,
      json: result.json,
      headers: name === 'getSession' ? { 'set-cookie': 'ca_session=mock; Path=/' } : {},
    });
  }

  match(method: string, path: string): [RouteName, Record<string, string>] | null {
    for (const [name, contract] of Object.entries(ROUTES) as Array<
      [RouteName, (typeof ROUTES)[RouteName]]
    >) {
      if (contract.method !== method) continue;
      const keys: string[] = [];
      const re = new RegExp(
        '^' +
          contract.path.replace(/\{(\w+)\}/g, (_, k: string) => (keys.push(k), '([^/]+)')) +
          '$',
      );
      const m = re.exec(path);
      if (m)
        return [name, Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]))];
    }
    return null;
  }

  private requireAccount() {
    return this.session.kind === 'account'
      ? null
      : ({
          error: 'account_required',
          status: 403,
          message: 'Create an account to continue.',
        } as const);
  }

  dispatch(
    name: RouteName,
    params: Record<string, string>,
    q: URLSearchParams,
    body: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    extra: { multipart: boolean; raw: Buffer | null },
  ): { json?: unknown; status?: number } | { error: string; status: number; message: string } {
    switch (name) {
      case 'getSession':
        return {
          json: {
            principal: {
              kind: this.session.kind,
              account_id: this.session.account_id,
              session_id: this.session.session_id,
              expires_at:
                this.session.kind === 'anonymous'
                  ? new Date(Date.now() + 86_400_000).toISOString()
                  : null,
              is_demo_owner: false,
            },
            csrf_token: this.session.csrf,
            ...(this.session.kind === 'account'
              ? { onboarding_required: this.onboarding.required }
              : {}),
          },
        };
      case 'createAccount': {
        if (this.opts.onboardingOnSignUp !== false) this.onboarding.required = true;
        this.session = {
          ...this.session,
          kind: 'account',
          account_id: uid(),
          csrf: 'csrf-' + uid(),
        };
        if (body?.pending_save) {
          const target =
            body.pending_save.target_type === 'capture'
              ? this.captures.get(body.pending_save.target_id)?.itemId
              : body.pending_save.target_id;
          if (target) {
            this.save(target);
            const card = this.cards.get(target);
            if (card && this.onboarding.required && card.kind !== 'capture')
              this.onboarding.addPendingSavePick(card.title, card.category, card.kind);
          }
        }
        return {
          json: {
            account_id: this.session.account_id,
            session_id: this.session.session_id,
            claimed: { captures: this.captures.size, saved_items: this.saved.size },
            onboarding_required: this.onboarding.required,
          },
        };
      }
      case 'getDiscoveries': {
        const cat = q.get('category');
        const limit = Number(q.get('limit') ?? 12);
        const start = Number(q.get('cursor') ?? 0);
        const ids = this.feedIds.filter(
          (id) => !this.hidden.has(id) && (!cat || this.cards.get(id)!.category === cat),
        );
        const page = ids.slice(start, start + limit);
        const next = start + limit < ids.length ? String(start + limit) : null;
        return {
          json: {
            items: page.map((id) => this.card(id)),
            next_cursor: next,
            feed_id: '00000000-0000-4000-8000-00000000feed',
            feed_revision: 1,
            is_example_feed: !this.opts.personalFeed,
            available_categories: (['wear', 'play', 'watch', 'eat'] as const).filter((c) =>
              this.feedIds.some((id) => this.cards.get(id)!.category === c),
            ),
          },
        };
      }
      case 'getItem': {
        const card = this.cards.get(params.id!);
        if (!card) return { error: 'not_found', status: 404, message: 'Not found.' };
        const seed = this.seeds.get(card.id)!;
        const capture = [...this.captures.values()].find((c) => c.itemId === card.id);
        const relatedIds = (this.related.get(card.id) ?? this.feedIds.slice(0, 3)).filter(
          (id) => !this.hidden.has(id),
        );
        return {
          json: {
            item: this.card(card.id),
            // Contract fields (sourced copy); the mock has no provider text.
            description: null,
            detail: null,
            reason: seed.reason,
            why_this: {
              text: `${seed.reason} It connects to things you looked at, by mood rather than by fact.`,
              sources: [
                {
                  id: uid(),
                  url: 'https://en.wikipedia.org/wiki/Endurance_racing_(motorsport)',
                  title: 'Endurance racing (motorsport)',
                  publisher: 'Wikipedia',
                  retrieved_at: now(),
                },
              ],
            },
            destination_url: card.kind === 'film' ? 'https://en.wikipedia.org/wiki/Film' : null,
            references: [
              {
                id: this.referenceId,
                name: 'Endurance racing jackets',
                type: 'style',
                relation: 'resembles',
                qualified: true,
                has_page: true,
              },
            ],
            related: relatedIds.slice(0, 6).map((id) => this.card(id)),
            related_state: 'cached',
            related_job_id: null,
            collection_ids: [...this.collections.values()]
              .filter((c) => c.members.some((m) => m.item_id === card.id))
              .map((c) => c.id),
            capture_id: capture?.id ?? null,
          },
        };
      }
      case 'discoverRelated': {
        const id = params.id!;
        const job = this.newJob('discover_related', { type: 'discovery_job', id: uid() }, () => {
          const current = this.related.get(id) ?? [];
          const extra = this.feedIds
            .filter((x) => x !== id && !current.includes(x))
            .slice(0, 6 - current.length);
          this.related.set(id, [...current, ...extra].slice(0, 6));
        });
        return { json: { job_id: job.id, discovery_job_id: job.result!.id, reused: false } };
      }
      case 'getJob': {
        const job = this.jobs.get(params.id!);
        if (!job) return { error: 'not_found', status: 404, message: 'Not found.' };
        this.advance(job);
        return { json: this.jobDto(job) };
      }
      case 'createCapture': {
        if (extra.multipart) {
          const text = extra.raw?.toString('latin1') ?? '';
          if (/filename="[^"]*\.hei[cf]"/i.test(text))
            return {
              error: 'unsupported_image',
              status: 400,
              message: 'HEIC photos can’t be read yet. Convert it to JPEG and try again.',
            };
          const c = this.createCapture(
            null,
            /name="source"\r\n\r\ncamera/.test(text) ? 'camera' : 'upload',
          );
          return { json: { capture_id: c.id, job_id: c.jobId, reused: false } };
        }
        const c = this.createCapture(body.sample_id ?? null, body.sample_id ? 'sample' : 'upload');
        return { json: { capture_id: c.id, job_id: c.jobId, reused: false } };
      }
      case 'getCapture': {
        const c = this.captures.get(params.id!);
        if (!c) return { error: 'not_found', status: 404, message: 'Not found.' };
        return { json: this.captureDto(c) };
      }
      case 'correctCapture': {
        const c = this.captures.get(params.id!);
        if (!c) return { error: 'not_found', status: 404, message: 'Not found.' };
        if (body.focus) c.focus = body.focus;
        // A retry or correction succeeds: discoveries become available again.
        this.opts.qlooUnavailable = false;
        this.opts.noSubject = false;
        const job = this.analyze(c);
        return {
          json: { capture_id: c.id, job_id: job.id, pending_analysis_version: c.version + 1 },
        };
      }
      case 'deleteCapture': {
        this.captures.delete(params.id!);
        return { status: 204 };
      }
      case 'getReference':
        return {
          json: {
            id: params.id,
            name: 'Endurance racing jackets',
            type: 'style',
            overview:
              'Cotton and nylon jackets in team colors became part of the look around endurance racing in the 1960s and 1970s. Today the style is widely reinterpreted.',
            sections: [
              {
                heading: 'Team colors',
                body: 'Sponsors’ liveries often carried over from cars to crew clothing, which is why bold stripes and badges are typical.',
                claim_ids: [],
              },
              {
                heading: 'A lasting influence',
                body: 'Fashion revivals often borrow the silhouette and stripes rather than any specific team’s design.',
                claim_ids: [],
              },
            ],
            claims: [],
            sources: [
              {
                id: uid(),
                url: 'https://en.wikipedia.org/wiki/Endurance_racing_(motorsport)',
                title: 'Endurance racing (motorsport)',
                publisher: 'Wikipedia',
                retrieved_at: now(),
              },
            ],
            related: this.feedIds.slice(0, 4).map((id) => this.card(id)),
            research_status: 'complete',
            revision: 1,
            updated_at: now(),
          },
        };
      case 'recordPreference': {
        const itemId =
          body.target_type === 'capture'
            ? this.captures.get(body.target_id)?.itemId
            : body.target_id;
        if (!itemId) return { error: 'not_found', status: 404, message: 'Not found.' };
        let savedItem = null;
        let undo = null;
        if (body.action === 'save') {
          // Same rule as the domain service: visitors must create an account to save.
          const denied = this.requireAccount();
          if (denied) return denied;
          const s = this.save(itemId);
          savedItem = { id: s.saved_item_id, discovery_item_id: itemId, saved_at: s.saved_at };
          undo = { action: 'remove', target_type: body.target_type, target_id: body.target_id };
        } else if (body.action === 'remove') {
          this.saved.delete(itemId);
          for (const c of this.collections.values())
            c.members = c.members.filter((m) => m.item_id !== itemId);
          undo = { action: 'save', target_type: body.target_type, target_id: body.target_id };
        } else if (body.action === 'hide') {
          this.hidden.add(itemId);
          undo = { action: 'unhide', target_type: body.target_type, target_id: body.target_id };
        } else if (body.action === 'unhide') {
          this.hidden.delete(itemId);
        }
        return {
          json: {
            action: body.action,
            target_type: body.target_type,
            target_id: body.target_id,
            saved_item: savedItem,
            taste_revision: 1,
            undo,
          },
        };
      }
      case 'listSaved': {
        const filter = q.get('filter') ?? 'all';
        const ids = filter === 'unfiled' ? this.unfiledIds() : [...this.saved.keys()];
        return {
          json: {
            items: ids.map((id) => {
              const cols = [...this.collections.values()].filter((c) =>
                c.members.some((m) => m.item_id === id),
              );
              return {
                saved_item_id: this.saved.get(id)!.saved_item_id,
                saved_at: this.saved.get(id)!.saved_at,
                item: this.card(id),
                membership_ids: cols.map(
                  (c) => c.members.find((m) => m.item_id === id)!.membership_id,
                ),
                collection_ids: cols.map((c) => c.id),
              };
            }),
            next_cursor: null,
          },
        };
      }
      case 'listCollections': {
        const denied = this.requireAccount();
        if (denied) return denied;
        const unfiled = this.unfiledIds();
        return {
          json: {
            collections: [...this.collections.values()].map((c) => this.collectionSummary(c)),
            unfiled: {
              item_count: unfiled.length,
              cover: unfiled
                .map((id) => this.cards.get(id)!.image)
                .filter((x): x is NonNullable<typeof x> => Boolean(x))
                .slice(0, 4),
            },
          },
        };
      }
      case 'createCollection': {
        const denied = this.requireAccount();
        if (denied) return denied;
        const c = this.createCollection(body.name, body.description ?? null);
        return { json: this.collectionSummary(c) };
      }
      case 'getCollection': {
        const c = this.collections.get(params.id!);
        if (!c) return { error: 'not_found', status: 404, message: 'Not found.' };
        const filter = q.get('filter');
        const kinds: Record<string, string[]> = {
          photos: ['capture'],
          music: ['artist', 'track'],
          films: ['film'],
          food: ['food'],
          style: ['style', 'brand'],
        };
        const members = c.members.filter(
          (m) => !filter || kinds[filter]!.includes(this.cards.get(m.item_id)!.kind),
        );
        const limit = Number(q.get('limit') ?? 24);
        const start = Number(q.get('cursor') ?? 0);
        const page = members.slice(start, start + limit);
        const items: CollectionMember[] = page.map((m) => ({
          membership_id: m.membership_id,
          saved_item_id: this.saved.get(m.item_id)!.saved_item_id,
          position: c.members.indexOf(m),
          added_at: m.added_at,
          item: this.card(m.item_id),
        }));
        return {
          json: {
            collection: this.collectionSummary(c),
            items,
            next_cursor: start + limit < members.length ? String(start + limit) : null,
            available_filters: (Object.keys(kinds) as Array<keyof typeof kinds>).filter((f) =>
              c.members.some((m) => kinds[f]!.includes(this.cards.get(m.item_id)!.kind)),
            ),
          },
        };
      }
      case 'updateCollection': {
        const c = this.collections.get(params.id!);
        if (!c) return { error: 'not_found', status: 404, message: 'Not found.' };
        if (body.expected_revision !== c.revision)
          return {
            error: 'revision_conflict',
            status: 409,
            message: 'This collection changed. Review the latest version and try again.',
          };
        if (body.name !== undefined) c.name = body.name;
        if (body.description !== undefined) c.description = body.description;
        c.revision += 1;
        c.updated_at = now();
        return { json: this.collectionSummary(c) };
      }
      case 'deleteCollection':
        this.collections.delete(params.id!);
        return { status: 204 };
      case 'addCollectionItem': {
        const c = this.collections.get(params.id!);
        if (!c || !this.cards.has(params.item_id!))
          return { error: 'not_found', status: 404, message: 'Not found.' };
        const r = this.addMember(c, params.item_id!);
        return {
          json: {
            collection_id: c.id,
            membership_id: r.membership_id,
            saved_item_id: this.saved.get(params.item_id!)!.saved_item_id,
            collection_revision: c.revision,
            created: r.created,
            saved: r.saved,
          },
        };
      }
      case 'removeCollectionItem': {
        const c = this.collections.get(params.id!);
        if (!c) return { error: 'not_found', status: 404, message: 'Not found.' };
        const before = c.members.length;
        c.members = c.members.filter((m) => m.item_id !== params.item_id);
        if (c.members.length !== before) c.revision += 1;
        return {
          json: {
            collection_id: c.id,
            collection_revision: c.revision,
            removed: c.members.length !== before,
          },
        };
      }
      case 'reorderCollection': {
        const c = this.collections.get(params.id!);
        if (!c) return { error: 'not_found', status: 404, message: 'Not found.' };
        if (body.expected_revision !== c.revision)
          return {
            error: 'revision_conflict',
            status: 409,
            message: 'This collection changed. Review the latest version and try again.',
          };
        const ids: string[] = body.membership_ids;
        if (
          ids.length !== c.members.length ||
          !c.members.every((m) => ids.includes(m.membership_id))
        )
          return { error: 'invalid_input', status: 400, message: 'The request is not valid.' };
        c.members = ids.map((id) => c.members.find((m) => m.membership_id === id)!);
        c.revision += 1;
        return { json: { collection_id: c.id, collection_revision: c.revision } };
      }
      case 'listPlans': {
        const denied = this.requireAccount();
        if (denied) return denied;
        return {
          json: {
            plans: [...this.plans.values()].map((p) => ({
              id: p.id,
              template: p.template,
              title: p.active_version?.title ?? null,
              status: p.status,
              cover: p.active_version?.film?.feature?.image ?? null,
              created_at: p.created_at,
            })),
            next_cursor: null,
          },
        };
      }
      case 'createPlan': {
        const c = this.collections.get(body.collection_id);
        if (!c) return { error: 'not_found', status: 404, message: 'Not found.' };
        if (body.expected_revision !== c.revision)
          return {
            error: 'revision_conflict',
            status: 409,
            message: 'This collection changed. Review the latest version and try again.',
          };
        const { plan, job } = this.createPlan(
          c.id,
          body.item_ids,
          body.exploration,
          body.constraints ?? {},
        );
        return { json: { plan_id: plan.id, job_id: job.id } };
      }
      case 'getPlan': {
        const p = this.plans.get(params.id!);
        if (!p) return { error: 'not_found', status: 404, message: 'Not found.' };
        const job = p.job_id ? this.jobs.get(p.job_id) : null;
        if (job && job.state !== 'queued' && job.state !== 'running') p.job_id = null;
        return {
          json: {
            ...p,
            status: p.active_version
              ? p.status
              : job
                ? job.state === 'queued'
                  ? 'queued'
                  : 'running'
                : p.status,
          },
        };
      }
      case 'replacePlanSection': {
        const p = this.plans.get(params.id!);
        if (!p?.active_version) return { error: 'not_found', status: 404, message: 'Not found.' };
        const section = body.section as 'film' | 'food' | 'music';
        const job = this.newJob('replace_plan_section', { type: 'plan', id: p.id }, () => {
          const prev = p.active_version!;
          const next: PlanVersionDto = { ...prev, version: prev.version + 1, created_at: now() };
          if (section === 'music') {
            next.music = {
              before: [
                {
                  item_id: null,
                  kind: 'artist',
                  title: 'Alice Coltrane',
                  artist: null,
                  image: null,
                  reason: null,
                  verified: false,
                  destination_url: null,
                  is_example: false,
                },
                {
                  item_id: null,
                  kind: 'artist',
                  title: 'Astrud Gilberto',
                  artist: null,
                  image: null,
                  reason: null,
                  verified: false,
                  destination_url: null,
                  is_example: false,
                },
                {
                  item_id: null,
                  kind: 'artist',
                  title: 'Ryuichi Sakamoto',
                  artist: null,
                  image: null,
                  reason: null,
                  verified: false,
                  destination_url: null,
                  is_example: false,
                },
              ],
              after: [],
            };
          } else if (section === 'food') {
            next.food = {
              dishes: [
                {
                  item_id: null,
                  title: 'Scallion pancakes',
                  description: 'Crisp, layered and easy to share.',
                  cuisine: 'Chinese-inspired',
                  reason: null,
                  image: null,
                  is_example: false,
                },
              ],
            };
          } else {
            next.film = {
              feature: { ...prev.film!.feature!, title: 'Chungking Express', year: 1994 },
              alternates: prev.film!.alternates,
            };
          }
          p.active_version = next;
          p.versions = [...p.versions, { version: next.version, created_at: now() }];
        });
        return { json: { plan_id: p.id, job_id: job.id, section } };
      }
      case 'deletePlan':
        this.plans.delete(params.id!);
        return { status: 204 };
      case 'listAgentConnections':
        return { json: { connections: this.agents } };
      case 'createAgentConnection': {
        const conn: AgentConnectionDto = {
          id: uid(),
          client_name: body.client_name,
          scopes: body.scopes,
          library_access: body.library_access,
          collection_ids: body.collection_ids,
          credential_prefix: 'cat_ab12',
          created_at: now(),
          expires_at: new Date(Date.now() + body.expires_in_days * 86_400_000).toISOString(),
          revoked_at: null,
          last_used_at: null,
          status: 'active',
          access_summary: {
            reads: ['Items in the collections you selected'],
            writes: [],
            limits: ['Cannot see unfiled saves or other collections'],
          },
        };
        this.agents.push(conn);
        return {
          json: {
            connection: conn,
            credential: 'cat_ab12_s3cr3t-shown-once',
            mcp_url: 'http://localhost:3000/mcp',
          },
        };
      }
      case 'revokeAgentConnection': {
        const conn = this.agents.find((a) => a.id === params.id);
        if (conn) conn.revoked_at = now();
        return { status: 204 };
      }
      case 'listSensorConnections':
        return { json: { connections: this.sensors } };
      case 'createSensorConnection': {
        const conn: SensorConnectionDto = {
          id: uid(),
          origin: body.origin,
          mode: body.mode,
          enabled: true,
          last_success_at: null,
          last_attempt_at: null,
          last_error_code: null,
          created_at: now(),
        };
        this.sensors.push(conn);
        return {
          json: {
            connection: conn,
            bridge_token: body.mode === 'bridge' ? 'cat_br01_bridge-token' : null,
          },
        };
      }
      case 'deleteSensorConnection':
        this.sensors = this.sensors.filter((s) => s.id !== params.id);
        return { status: 204 };
      default: {
        if (this.session.kind !== 'account' && /Onboarding|TastePick/.test(name))
          return { error: 'account_required', status: 403, message: 'Create an account to continue.' };
        const handled = this.onboarding.dispatch(name, params, q, body);
        if (handled) return handled;
        return { error: 'not_implemented', status: 501, message: 'Not mocked.' };
      }
    }
  }
}

/** Installs the mock on a page; returns it for assertions. */
export async function installMockApi(page: Page, opts: MockOptions = {}): Promise<MockApi> {
  const api = new MockApi(opts);
  await page.route(/\/v1\//, (route) => api.handle(route));
  return api;
}
