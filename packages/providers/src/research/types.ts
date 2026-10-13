import type { CapabilityEntry } from '../capabilities';
import type { CallOptions } from '../errors';

/**
 * Reference research: find primary/authoritative sources (Wikipedia/Wikimedia
 * REST with real URLs), then extract individual claims with their source URLs
 * (text model). Factual claims without a supporting source are dropped or kept
 * as qualified interpretation. Full articles are NOT stored; only display
 * metadata and the claims.
 */
export interface ResearchQuery {
  name: string;
  type: string;
  /** Short descriptive context from the analysis, never private user data. */
  context?: string;
  lang?: string;
  limit?: number;
}

export interface ResearchSourceDoc {
  url: string;
  title: string;
  publisher: string;
  retrieved_at: string;
  /** Text used for claim extraction only (not persisted). */
  extract: string;
  license?: string;
  wikidata_id?: string;
  thumbnail?: { url: string; width: number; height: number; license?: string };
}

export interface ResearchExtraction {
  /** Under 150 words. */
  overview: string;
  /** Up to three sections; whole page under 500 words. */
  sections: { heading: string; body: string; claim_indexes: number[] }[];
  claims: { text: string; claim_type: 'factual' | 'interpretive'; source_urls: string[] }[];
}

export interface ResearchProvider {
  readonly id: string;
  capability(): { sources: CapabilityEntry; claims: CapabilityEntry };
  findSources(query: ResearchQuery, options?: CallOptions): Promise<ResearchSourceDoc[]>;
  extractClaims(
    input: { name: string; type: string; sources: ResearchSourceDoc[]; maxClaims?: number },
    options?: CallOptions,
  ): Promise<ResearchExtraction>;
}
