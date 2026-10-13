import type { z } from 'zod';
import type { CapabilityEntry } from '../capabilities';
import { ProviderError } from '../errors';
import type {
  QlooCapabilities,
  QlooEntity,
  QlooEntityTrendsResult,
  QlooInsightsResult,
  QlooProvider,
  QlooResponse,
  QlooSanitizedRequest,
  QlooTag,
  QlooTrendingResult,
} from '../qloo/types';
import type { ResearchExtraction, ResearchProvider, ResearchSourceDoc } from '../research/types';
import type { StructuredRequest, StructuredResult, TextModelProvider } from '../text/types';
import { VlmAnalysis, type VlmAnalyzeInput, type VlmProvider, type VlmResult } from '../vlm/types';

/**
 * Deterministic fakes for unit/integration tests. They never pretend to be live:
 * the fake Qloo marks responses is_replay=true unless `live` is set explicitly
 * by a test that is simulating a live provider.
 */

const AVAILABLE: CapabilityEntry = { status: 'available', provider: 'fake' };

export class FakeVlm implements VlmProvider {
  readonly id = 'vlm:fake';
  readonly calls: VlmAnalyzeInput[] = [];
  constructor(private readonly respond: (input: VlmAnalyzeInput) => VlmAnalysis | Error) {}
  capability(): CapabilityEntry {
    return AVAILABLE;
  }
  async analyzeImage(input: VlmAnalyzeInput): Promise<VlmResult> {
    this.calls.push(input);
    const out = this.respond(input);
    if (out instanceof Error) throw out;
    return { analysis: VlmAnalysis.parse(out), model: 'fake-vlm', durationMs: 1 };
  }
}

export class FakeTextModel implements TextModelProvider {
  readonly id = 'text:fake';
  readonly calls: StructuredRequest<z.ZodType>[] = [];
  constructor(private readonly respond: (req: StructuredRequest<z.ZodType>) => unknown) {}
  capability(): CapabilityEntry {
    return AVAILABLE;
  }
  async generateStructured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResult<z.infer<T>>> {
    this.calls.push(req);
    const out = this.respond(req);
    if (out instanceof Error) throw out;
    return { data: req.schema.parse(out), model: 'fake-text', durationMs: 1 };
  }
}

export class FakeResearch implements ResearchProvider {
  readonly id = 'research:fake';
  constructor(
    private readonly sources: (name: string) => ResearchSourceDoc[],
    private readonly extraction: (name: string) => ResearchExtraction,
  ) {}
  capability() {
    return { sources: AVAILABLE, claims: AVAILABLE };
  }
  async findSources(q: { name: string }): Promise<ResearchSourceDoc[]> {
    return this.sources(q.name);
  }
  async extractClaims(input: { name: string }): Promise<ResearchExtraction> {
    return this.extraction(input.name);
  }
}

export interface FakeQlooHandlers {
  search?: (query: string, types?: string[]) => QlooEntity[] | Error;
  tags?: (query: string) => QlooTag[] | Error;
  insights?: (req: Parameters<QlooProvider['insights']>[0]) => QlooInsightsResult | Error;
  trending?: () => QlooTrendingResult | Error;
  entityTrends?: (entityId: string) => QlooEntityTrendsResult | Error;
}

export class FakeQloo implements QlooProvider {
  readonly id = 'qloo:fake';
  readonly calls: { op: string; req: unknown }[] = [];
  constructor(
    private readonly handlers: FakeQlooHandlers,
    private readonly options: { live?: boolean } = {},
  ) {}
  capability(): QlooCapabilities {
    return {
      search: AVAILABLE,
      tags: AVAILABLE,
      insights: AVAILABLE,
      explainability: AVAILABLE,
      trending: AVAILABLE,
      trendsEntity: AVAILABLE,
    };
  }
  private wrap<T>(op: string, path: string, req: unknown, out: T | Error | undefined): QlooResponse<T> {
    this.calls.push({ op, req });
    if (out === undefined) throw new ProviderError('qloo', 'unavailable', `fake qloo has no ${op} handler`);
    if (out instanceof Error) throw out;
    const request: QlooSanitizedRequest = { method: 'GET', path, query: {} };
    return {
      data: out,
      request,
      status: 200,
      retrieved_at: new Date().toISOString(),
      duration_ms: 1,
      is_replay: !this.options.live,
    };
  }
  async searchEntities(req: Parameters<QlooProvider['searchEntities']>[0]) {
    return this.wrap('search', '/search', req, this.handlers.search?.(req.query, req.types));
  }
  async lookupTags(req: Parameters<QlooProvider['lookupTags']>[0]) {
    return this.wrap('tags', '/v2/tags', req, this.handlers.tags?.(req.query));
  }
  async insights(req: Parameters<QlooProvider['insights']>[0]) {
    return this.wrap('insights', '/v2/insights', req, this.handlers.insights?.(req));
  }
  async trending(req: Parameters<QlooProvider['trending']>[0]) {
    return this.wrap('trending', '/v2/trending', req, this.handlers.trending?.());
  }
  async entityTrends(req: Parameters<QlooProvider['entityTrends']>[0]) {
    return this.wrap('entityTrends', '/trends/entity', req, this.handlers.entityTrends?.(req.entityId));
  }
}
