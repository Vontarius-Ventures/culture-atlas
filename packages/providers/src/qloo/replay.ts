import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CapabilityEntry } from '../capabilities';
import { ProviderError, type CallOptions } from '../errors';
import { parseEntityTrends, parseInsights, parseSearch, parseTags, parseTrending } from './parse';
import type {
  QlooCapabilities,
  QlooEntityTrendsRequest,
  QlooInsightsRequest,
  QlooProvider,
  QlooResponse,
  QlooSanitizedRequest,
  QlooSearchRequest,
  QlooTagsRequest,
  QlooTrendingRequest,
} from './types';

/**
 * Replays SANITIZED REAL recordings (written by `scripts/probe-qloo.ts --record`
 * with a real key). Only an exact request match is served; anything else is
 * 'unavailable'. Every response carries is_replay=true so the pipeline labels
 * results "Example result". Shape-only contract fixtures (fixtures/qloo/contract)
 * are NEVER served here: they are for adapter tests only.
 */

export interface QlooRecording {
  op: 'search' | 'tags' | 'insights' | 'trending' | 'trendsEntity';
  request: QlooSanitizedRequest;
  status: number;
  body: unknown;
  recorded_at: string;
}

export function recordingKey(op: string, query: Record<string, string | string[]>): string {
  const norm = Object.keys(query)
    .sort()
    .map((k) => `${k}=${Array.isArray(query[k]) ? (query[k] as string[]).join(',') : query[k]}`)
    .join('&');
  return `${op}?${norm}`;
}

export class ReplayQloo implements QlooProvider {
  readonly id = 'qloo:replay';
  private readonly byKey = new Map<string, QlooRecording>();

  constructor(recordings: QlooRecording[]) {
    for (const r of recordings) this.byKey.set(recordingKey(r.op, r.request.query), r);
  }

  get size(): number {
    return this.byKey.size;
  }

  capability(): QlooCapabilities {
    const e: CapabilityEntry = { status: 'degraded', reason: 'not_configured', detail: 'QLOO_API_KEY unset; replaying recorded responses labeled "Example result"', provider: 'qloo:replay', checked_at: null };
    return { search: e, tags: e, insights: e, explainability: e, trending: e, trendsEntity: e };
  }

  private serve<T>(op: QlooRecording['op'], path: string, query: Record<string, string | string[] | undefined>, parse: (b: unknown) => T): QlooResponse<T> {
    const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as Record<string, string | string[]>;
    const rec = this.byKey.get(recordingKey(op, clean));
    if (!rec) throw new ProviderError('qloo', 'unavailable', `no recorded qloo ${op} response for this request`);
    return {
      data: parse(rec.body),
      request: { method: 'GET', path, query: clean },
      status: rec.status,
      retrieved_at: rec.recorded_at,
      duration_ms: 0,
      is_replay: true,
    };
  }

  async searchEntities(req: QlooSearchRequest, _o?: CallOptions) {
    return this.serve('search', '/search', { query: req.query.trim(), types: req.types ? [...req.types] : undefined, take: String(Math.min(req.take ?? 5, 100)) }, parseSearch);
  }
  async lookupTags(req: QlooTagsRequest, _o?: CallOptions) {
    return this.serve('tags', '/v2/tags', { 'filter.query': req.query.trim(), 'filter.tag.types': req.tagTypes, take: String(Math.min(req.take ?? 5, 50)) }, parseTags);
  }
  async insights(req: QlooInsightsRequest, _o?: CallOptions) {
    return this.serve(
      'insights',
      '/v2/insights',
      {
        'filter.type': req.filterType,
        'signal.interests.entities': req.signalEntities,
        'signal.interests.tags': req.signalTags?.map((t) => t.id),
        'feature.explainability': req.explainability ? 'true' : undefined,
        take: String(Math.min(req.take ?? 10, 50)),
      },
      parseInsights,
    );
  }
  async trending(req: QlooTrendingRequest, _o?: CallOptions) {
    return this.serve('trending', '/v2/trending', { 'signal.interests.entities': req.signalEntities, 'filter.type': req.filterType, 'filter.start_date': req.startDate, 'filter.end_date': req.endDate, take: String(Math.min(req.take ?? 10, 50)) }, parseTrending);
  }
  async entityTrends(req: QlooEntityTrendsRequest, _o?: CallOptions) {
    return this.serve('trendsEntity', '/trends/entity', { entity_id: req.entityId, start_date: req.startDate, end_date: req.endDate }, (b) => parseEntityTrends(b, req.entityId));
  }
}

/** Loads recordings from a directory of *.json files; null when none exist. */
export function createReplayQloo(dir: string | undefined): ReplayQloo | null {
  if (!dir) return null;
  const abs = path.resolve(dir);
  if (!existsSync(abs)) return null;
  const recordings: QlooRecording[] = [];
  for (const file of readdirSync(abs)) {
    if (!file.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(readFileSync(path.join(abs, file), 'utf8')) as QlooRecording;
      if (rec && rec.op && rec.request && rec.body !== undefined) recordings.push(rec);
    } catch {
      // Ignore unreadable files; replay only serves well-formed recordings.
    }
  }
  return recordings.length ? new ReplayQloo(recordings) : null;
}
