import { randomUUID } from 'node:crypto';
import { ProviderError } from '../errors';
import type { GatewayResponse, ModelIdentity, ModelRole } from './types';
import type { ModelProfile } from '../concentrate/profiles';

export interface InferenceAttempt {
  id: string;
  identity: ModelIdentity;
  day: string;
  role: ModelRole;
  gateway: string;
  requestedModel: string;
  requestedProvider: string;
  returnedModel: string | null;
  actualProvider: string | null;
  responseId: string | null;
  profileVersion: string;
  promptVersion: string;
  schemaVersion: string;
  pricingSnapshotVersion: string;
  reservedMicros: number;
  costMicros: number | null;
  usage: GatewayResponse['usage'];
  state: 'reserved' | 'unknown' | 'settled';
  outcome: string;
  startedAt: number;
  completedAt: number | null;
}
export interface SpendState {
  attempts: InferenceAttempt[];
  pause: null | { reason: 'credits' | 'rate_limited' | 'cost_overrun'; until: number | null };
}
/** Must serialize transactions across ALL workers and persist before returning. Never auto-release unknown/stale reservations. */
export interface SpendStore {
  readonly durable: boolean;
  transaction<T>(update: (state: SpendState) => T): Promise<T>;
  read(): Promise<SpendState>;
}
export class MemorySpendStore implements SpendStore {
  readonly durable = false;
  private state: SpendState = { attempts: [], pause: null };
  async read(): Promise<SpendState> {
    return structuredClone(this.state);
  }
  async transaction<T>(update: (state: SpendState) => T): Promise<T> {
    const draft = structuredClone(this.state);
    const result = update(draft);
    this.state = draft;
    return structuredClone(result);
  }
}
export interface SpendLimits {
  dailyMicros: number;
  accountDailyMicros: number;
  maxUnknownMicros: number;
  accountDailyAnalyses: number;
}

export class ModelSpendLedger {
  constructor(
    readonly store: SpendStore,
    readonly limits: SpendLimits,
    readonly now = Date.now,
  ) {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid spend limits');
  }
  async status(): Promise<SpendState['pause']> {
    const s = await this.store.read();
    return s.pause && (s.pause.until === null || s.pause.until > this.now()) ? s.pause : null;
  }
  async reserve(identity: ModelIdentity, profile: ModelProfile): Promise<string> {
    if (
      !identity.accountId ||
      !identity.jobId ||
      !identity.attemptKey ||
      identity.jobId.length > 200 ||
      identity.attemptKey.length > 240
    ) {
      throw new ProviderError('model-gateway', 'bad_request', 'Analysis identity required');
    }
    return this.store.transaction((s) => {
      const now = this.now();
      if (s.pause && (s.pause.until === null || s.pause.until > now))
        throw new ProviderError(
          'model-gateway',
          s.pause.reason === 'rate_limited' ? 'rate_limited' : 'budget_exhausted',
          'AI dispatch paused',
          {
            retryAfterMs: s.pause.until === null ? undefined : s.pause.until - now,
          },
        );
      const day = new Date(now).toISOString().slice(0, 10);
      if (
        s.attempts.some(
          (a) =>
            a.identity.accountId === identity.accountId &&
            a.identity.jobId === identity.jobId &&
            a.role === profile.role &&
            a.identity.attemptKey === identity.attemptKey,
        )
      ) {
        throw new ProviderError(
          'model-gateway',
          'unavailable',
          'Attempt already reserved; reconcile rather than dispatch twice',
        );
      }
      const outstanding = s.attempts.filter((a) => a.state !== 'settled');
      const counted = s.attempts.filter((a) => a.day === day || a.state !== 'settled');
      const charge = (a: InferenceAttempt) =>
        a.state === 'settled' ? a.costMicros! : a.reservedMicros;
      const sum = (attempts: InferenceAttempt[]) =>
        attempts.reduce((total, a) => total + charge(a), 0);
      const owned = counted.filter((a) => a.identity.accountId === identity.accountId);
      const analyses = new Set(
        s.attempts
          .filter((a) => a.day === day && a.identity.accountId === identity.accountId)
          .map((a) => a.identity.jobId),
      );
      if (
        sum(counted) + profile.reservationMicros > this.limits.dailyMicros ||
        sum(owned) + profile.reservationMicros > this.limits.accountDailyMicros ||
        sum(outstanding) + profile.reservationMicros > this.limits.maxUnknownMicros ||
        (!analyses.has(identity.jobId) && analyses.size >= this.limits.accountDailyAnalyses)
      ) {
        throw new ProviderError(
          'model-gateway',
          'budget_exhausted',
          'Analysis allowance exhausted',
        );
      }
      const id = randomUUID();
      s.attempts.push({
        id,
        identity: { ...identity },
        day,
        role: profile.role,
        gateway: profile.gateway,
        requestedModel: profile.model,
        requestedProvider: profile.provider,
        returnedModel: null,
        actualProvider: null,
        responseId: null,
        usage: null,
        profileVersion: profile.version,
        promptVersion: profile.promptVersion,
        schemaVersion: profile.schemaVersion,
        pricingSnapshotVersion: profile.pricingSnapshotVersion,
        reservedMicros: profile.reservationMicros,
        costMicros: null,
        state: 'reserved',
        outcome: 'dispatched',
        startedAt: now,
        completedAt: null,
      });
      return id;
    });
  }
  async finish(
    id: string,
    outcome: string,
    response?: GatewayResponse,
    pause?: SpendState['pause'],
  ): Promise<void> {
    await this.store.transaction((s) => {
      const attempt = s.attempts.find((a) => a.id === id);
      if (!attempt || attempt.state !== 'reserved') throw new Error('Invalid attempt transition');
      // Even HTTP errors/timeouts may have billed work. Usage is not an actual dollar charge.
      Object.assign(attempt, {
        state: 'unknown',
        outcome,
        completedAt: this.now(),
        usage: response?.usage ?? null,
        returnedModel: response?.model ?? null,
        actualProvider: response?.actualProvider ?? null,
        responseId: response?.id ?? null,
      });
      if (pause && (!s.pause || s.pause.until !== null)) {
        // A late 429 completion cannot undo an earlier hard credit/cost pause.
        s.pause = pause;
      }
    });
  }
  /** Operator/billing reconciler only, never called from nullable token usage. Idempotent. */
  async reconcile(id: string, actualCostMicros: number): Promise<void> {
    if (!Number.isSafeInteger(actualCostMicros) || actualCostMicros < 0)
      throw new Error('Invalid actual cost');
    await this.store.transaction((s) => {
      const attempt = s.attempts.find((a) => a.id === id);
      if (!attempt) throw new Error('Unknown attempt');
      if (attempt.state === 'reserved') throw new Error('Cannot reconcile an in-flight attempt');
      if (attempt.state === 'settled') {
        if (attempt.costMicros !== actualCostMicros)
          throw new Error('Conflicting billing reconciliation');
        return;
      }
      attempt.state = 'settled';
      attempt.costMicros = actualCostMicros;
      if (actualCostMicros > attempt.reservedMicros)
        s.pause = { reason: 'cost_overrun', until: null };
    });
  }
  /** Explicit operator action after credits/profile verification, never a paid health probe. */
  async resume(): Promise<void> {
    await this.store.transaction((s) => {
      s.pause = null;
    });
  }
}
