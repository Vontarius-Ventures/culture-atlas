import { unavailable, type CapabilityEntry, type CapabilityReason } from './capabilities';
import { ProviderError } from './errors';
import type { MusicRecognitionProvider } from './music/types';
import type { QlooCapabilities, QlooProvider } from './qloo/types';
import type { ResearchProvider } from './research/types';
import type { ObjectStorage } from './storage/types';
import type { TextModelProvider } from './text/types';
import type { VlmEnricher, VlmProvider } from './vlm/types';
import type { VlmVerifier } from './vlm/verify';

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

/**
 * Key is present and a catalog pin / profile names a model, but the role is
 * not dispatchable (no qualified artifact, or no durable ledger). Health reports
 * `unverified`; every call still throws. Never contacts the gateway.
 */
export class UnverifiedVlm implements VlmProvider {
  readonly id: string;
  constructor(
    private readonly model: string,
    private readonly detail = 'Configured; not dispatchable until a matching qualification artifact exists',
  ) {
    this.id = `vlm:concentrate:unverified:${model}`;
  }
  capability(): CapabilityEntry {
    return {
      status: 'unverified',
      reason: 'probe_pending',
      provider: `concentrate:${this.model}`,
      detail: this.detail,
      checked_at: null,
    };
  }
  async analyzeImage(): Promise<never> {
    return fail('vlm', 'probe_pending');
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

/** The verifier without a qualified vision_verify profile (never a fallback model). */
export class UnavailableVlmVerifier implements VlmVerifier {
  readonly id = 'vlm-verify:unavailable';
  constructor(private readonly reason: CapabilityReason = 'not_configured') {}
  capability(): CapabilityEntry {
    return unavailable(this.reason);
  }
  async verifyImage(): Promise<never> {
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

/** Same as UnverifiedVlm for research/composer text roles. */
export class UnverifiedTextModel implements TextModelProvider {
  readonly id: string;
  constructor(
    private readonly model: string,
    private readonly detail = 'Configured; not dispatchable until a matching qualification artifact exists',
  ) {
    this.id = `text:concentrate:unverified:${model}`;
  }
  capability(): CapabilityEntry {
    return {
      status: 'unverified',
      reason: 'probe_pending',
      provider: `concentrate:${this.model}`,
      detail: this.detail,
      checked_at: null,
    };
  }
  async generateStructured(): Promise<never> {
    return fail('text', 'probe_pending');
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

/**
 * Music recognition is not implemented this release. Calls throw; they never
 * invent a track, artist or recording id.
 */
export class UnavailableMusicRecognition implements MusicRecognitionProvider {
  readonly id = 'music:unavailable';
  constructor(private readonly reason: CapabilityReason = 'not_implemented') {}
  capability(): CapabilityEntry {
    return unavailable(this.reason, 'No licensed music-recognition provider is configured');
  }
  async recognize(): Promise<never> {
    return fail('music', this.reason);
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
