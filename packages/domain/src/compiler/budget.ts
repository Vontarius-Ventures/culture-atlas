import type { RequestBudget } from '@culture-atlas/providers';

/**
 * Per-job provider budget (build spec: at most 12 Qloo requests and five
 * researched references per job, two retries per provider stage; all
 * configurable). Every HTTP attempt to Qloo — first tries and retries — counts
 * toward the Qloo limit. Retries are additionally limited per stage.
 * `initialUsed` lets a re-attempted job continue from what earlier attempts
 * already spent (recorded in provider_queries).
 */
export class JobBudget {
  private readonly used = new Map<string, number>();
  private readonly stageRetries = new Map<string, number>();
  private exhausted = new Set<string>();

  constructor(
    readonly limits: {
      qlooRequests: number;
      researchRefs: number;
      retriesPerStage: number;
      /** Photo-reading model calls per job (quick read + enrichment); default 2. */
      visionCalls?: number;
    },
    initialUsed: { qloo?: number } = {},
  ) {
    this.used.set('qloo', initialUsed.qloo ?? 0);
  }

  private visionReserved = 0;

  /**
   * Reserves logical photo-reading model calls for this job up front
   * (amendment 2.2: the stage-1 quick read and the stage-2 enrichment are
   * reserved together, at most LIMITS.visionCallsPerAnalysis). Returns false
   * without reserving anything when the request would exceed the limit.
   * HTTP retries of a reserved call are still limited per stage by forStage.
   */
  reserveVisionCalls(calls: number): boolean {
    const limit = this.limits.visionCalls ?? 2;
    if (!Number.isSafeInteger(calls) || calls <= 0 || this.visionReserved + calls > limit) return false;
    this.visionReserved += calls;
    return true;
  }

  visionCallsReserved(): number {
    return this.visionReserved;
  }

  usedBy(provider: string): number {
    return this.used.get(provider) ?? 0;
  }

  remaining(provider: 'qloo'): number {
    return Math.max(0, this.limits.qlooRequests - this.usedBy(provider));
  }

  wasExhausted(provider: string): boolean {
    return this.exhausted.has(provider);
  }

  /**
   * Charge requests that were made without the adapter consulting the budget
   * (e.g. test fakes or providers without HTTP attempts), so the limit holds
   * for every provider implementation.
   */
  charge(provider: string, n: number): void {
    this.used.set(provider, this.usedBy(provider) + Math.max(0, n));
  }

  /** A RequestBudget scoped to one stage (retry limit is per stage). */
  forStage(stage: string): RequestBudget {
    return {
      take: (provider, kind) => {
        if (provider === 'qloo' && this.usedBy('qloo') >= this.limits.qlooRequests) {
          this.exhausted.add('qloo');
          return false;
        }
        if (kind === 'retry') {
          const n = this.stageRetries.get(stage) ?? 0;
          if (n >= this.limits.retriesPerStage) return false;
          this.stageRetries.set(stage, n + 1);
        }
        this.used.set(provider, this.usedBy(provider) + 1);
        return true;
      },
    };
  }
}
