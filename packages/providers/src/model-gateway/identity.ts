import type { z } from 'zod';
import type { CallOptions } from '../errors';
import type { ProviderRegistry } from '../registry';
import type { ResearchProvider } from '../research/types';
import type { StructuredRequest, StructuredResult, TextModelProvider } from '../text/types';
import type { VlmAnalyzeInput, VlmProvider, VlmResult } from '../vlm/types';
import type { ModelIdentity } from './types';

/**
 * Supplies a fresh, verified identity per model call: the budgeted gateway
 * reserves one ledger row per (account, job, role, attemptKey), so every
 * logical call inside a job attempt needs its own stable key.
 */
export function identitySequence(base: {
  accountId: string;
  jobId: string;
  prefix: string;
}): (operation: string) => ModelIdentity {
  let n = 0;
  return (operation) => ({
    accountId: base.accountId,
    jobId: base.jobId,
    attemptKey: `${base.prefix}:${operation}:${n++}`.slice(0, 200),
  });
}

type NextIdentity = (operation: string) => ModelIdentity | undefined;
function withIdentity(
  options: CallOptions | undefined,
  next: NextIdentity,
  operation: string,
): CallOptions {
  if (options?.modelIdentity) return options;
  const modelIdentity = next(operation);
  return modelIdentity ? { ...options, modelIdentity } : { ...options };
}

class BoundVlm implements VlmProvider {
  constructor(
    private readonly inner: VlmProvider,
    private readonly next: NextIdentity,
  ) {}
  get id() {
    return this.inner.id;
  }
  capability() {
    return this.inner.capability();
  }
  analyzeImage(input: VlmAnalyzeInput, options?: CallOptions): Promise<VlmResult> {
    return this.inner.analyzeImage(input, withIdentity(options, this.next, 'vlm'));
  }
}

class BoundText implements TextModelProvider {
  constructor(
    private readonly inner: TextModelProvider,
    private readonly next: NextIdentity,
  ) {}
  get id() {
    return this.inner.id;
  }
  capability() {
    return this.inner.capability();
  }
  generateStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
    options?: CallOptions,
  ): Promise<StructuredResult<z.infer<T>>> {
    return this.inner.generateStructured(
      request,
      withIdentity(options, this.next, request.schemaName),
    );
  }
}

/**
 * Per-job view of the registry whose model adapters attach server-owned job
 * identity when the caller did not. Providers that ignore identity
 * (Featherless/Anthropic rollback, Qloo, storage) are unaffected.
 */
export function bindModelIdentity(
  registry: ProviderRegistry,
  next: NextIdentity,
): ProviderRegistry {
  const research: ResearchProvider = {
    id: registry.research.id,
    capability: () => registry.research.capability(),
    findSources: (input, options) => registry.research.findSources(input, options),
    extractClaims: (input, options) =>
      registry.research.extractClaims(input, withIdentity(options, next, 'reference_notes')),
  };
  return {
    ...registry,
    config: registry.config,
    vlm: new BoundVlm(registry.vlm, next),
    text: new BoundText(registry.text, next),
    composer: new BoundText(registry.composer, next),
    research,
    capabilities: () => registry.capabilities(),
  };
}
