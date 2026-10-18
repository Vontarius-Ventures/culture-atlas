import { unavailable, type CapabilityEntry, type CapabilityReason } from './capabilities';
import { ProviderError } from './errors';
import type { QlooCapabilities, QlooProvider } from './qloo/types';
import type { ResearchProvider } from './research/types';
import type { ObjectStorage } from './storage/types';
import type { TextModelProvider } from './text/types';
import type { VlmEnricher, VlmProvider } from './vlm/types';

/**
 * Placeholder implementations used when a provider is not configured or its
 * adapter is not implemented yet. They report 'unavailable' and throw
 * ProviderError('unavailable') on every call — they never fabricate data.
 */

const fail = (provider: string, reason: CapabilityReason): never => {
  throw new ProviderError(provider, 'unavailable', `${provider} is unavailable (${reason})`);
};

export class UnavailableVlm implements VlmProvider {
  readonly id = 'vlm:unavailable';
  constructor(private readonly reason: CapabilityReason = 'not_configured') {}
  capability(): CapabilityEntry {
    return unavailable(this.reason);
  }
  async analyzeImage(): Promise<never> {
    return fail('vlm', this.reason);
  }
}

/** Stage-2 enrichment without a qualified vision_photo_enrich profile (never a fallback model). */
export class UnavailableVlmEnricher implements VlmEnricher {
  readonly id = 'vlm-enrich:unavailable';
  constructor(private readonly reason: CapabilityReason = 'not_configured') {}
  capability(): CapabilityEntry {
    return unavailable(this.reason);
  }
  async enrichImage(): Promise<never> {
    return fail('vlm', this.reason);
  }
}

export class UnavailableTextModel implements TextModelProvider {
  readonly id = 'text:unavailable';
  constructor(private readonly reason: CapabilityReason = 'not_configured') {}
  capability(): CapabilityEntry {
    return unavailable(this.reason);
  }
  async generateStructured(): Promise<never> {
    return fail('text', this.reason);
  }
}

export class UnavailableResearch implements ResearchProvider {
  readonly id = 'research:unavailable';
  constructor(private readonly reason: CapabilityReason = 'not_implemented') {}
  capability() {
    return { sources: unavailable(this.reason), claims: unavailable(this.reason) };
  }
  async findSources(): Promise<never> {
    return fail('research', this.reason);
  }
  async extractClaims(): Promise<never> {
    return fail('research', this.reason);
  }
}

export class UnavailableQloo implements QlooProvider {
  readonly id = 'qloo:unavailable';
  constructor(private readonly reason: CapabilityReason = 'not_configured') {}
  capability(): QlooCapabilities {
    const e = unavailable(this.reason, this.reason === 'not_configured' ? 'QLOO_API_KEY is not set' : undefined, 'qloo');
    return { search: e, tags: e, insights: e, explainability: e, trending: e, trendsEntity: e };
  }
  async searchEntities(): Promise<never> {
    return fail('qloo', this.reason);
  }
  async lookupTags(): Promise<never> {
    return fail('qloo', this.reason);
  }
  async insights(): Promise<never> {
    return fail('qloo', this.reason);
  }
  async trending(): Promise<never> {
    return fail('qloo', this.reason);
  }
  async entityTrends(): Promise<never> {
    return fail('qloo', this.reason);
  }
}

export class UnavailableStorage implements ObjectStorage {
  readonly driver = 'memory' as const;
  constructor(private readonly reason: CapabilityReason = 'not_implemented') {}
  capability() {
    return { objects: unavailable(this.reason), signedUrls: unavailable(this.reason) };
  }
  async put(): Promise<never> {
    return fail('storage', this.reason);
  }
  async get(): Promise<never> {
    return fail('storage', this.reason);
  }
  async delete(): Promise<never> {
    return fail('storage', this.reason);
  }
  async deletePrefix(): Promise<never> {
    return fail('storage', this.reason);
  }
  async signedUrl(): Promise<never> {
    return fail('storage', this.reason);
  }
}
