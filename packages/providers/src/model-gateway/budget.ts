import { randomUUID } from 'node:crypto';
import { ProviderError } from '../errors';
import type { GatewayResponse, ModelIdentity, ModelRole } from './types';
import type { ModelProfile } from '../concentrate/profiles';

/** One HTTP attempt (the `inference_attempts` contract record). Safe metadata only. */
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
  /** Gateway request id from response headers, when the gateway returns one. */
  requestId?: string | null;
  profileVersion: string;
  promptVersion: string;
  schemaVersion: string;
  pricingSnapshotVersion: string;
  reservedMicros: number;
  /** Reconciled actual charge; null means unknown, never zero. */
  costMicros: number | null;
  usage: GatewayResponse['usage'];
  state: 'reserved' | 'unknown' | 'settled';
  outcome: string;
  startedAt: number;
  completedAt: number | null;
}
export type SpendPause = null | {
  reason: 'credits' | 'rate_limited' | 'cost_overrun';
  until: number | null;
};
/** Durable per-role circuit: opened by auth/unknown-model/policy failures, closed by an operator. */
export interface RoleCircuit {
  reason: 'auth' | 'unknown_model' | 'policy' | 'route_mismatch';
  at: number;
}
export interface SpendState {
  attempts: InferenceAttempt[];
  pause: SpendPause;
  circuits?: Partial<Record<ModelRole, RoleCircuit>>;
}
export interface SpendControl {
  pause: SpendPause;
  circuits: Partial<Record<ModelRole, RoleCircuit>>;
}
/**
 * Rows a decision needs. Stores may load only these (plus the control row);
 * the in-memory store ignores it. Every attempt that can influence a decision
 * is included: the day's attempts, every unsettled attempt, and the target.
 * `totalBound` marks a decision that enforces the ALL-TIME total ceiling
 * (VAL-OPS-002): settled rows from prior days now matter, so the store must
 * read the FULL history, not the day's slice.
 */
export interface SpendScope {
  day: string;
  attemptId?: string;
  identity?: { accountId: string; jobId: string; role: ModelRole; attemptKey: string };
  totalBound?: boolean;
}
/** Must serialize transactions across ALL workers and persist before returning. Never auto-release unknown/stale reservations. */
export interface SpendStore {
  readonly durable: boolean;
  transaction<T>(update: (state: SpendState) => T, scope?: SpendScope): Promise<T>;
  /** Operator/test view of every attempt. Not used on the dispatch path. */
  read(): Promise<SpendState>;
  /** Cheap read-only control state for readiness. */
  readControl?(): Promise<SpendControl>;
}
export class MemorySpendStore implements SpendStore {
  readonly durable = false;
  private state: SpendState = { attempts: [], pause: null, circuits: {} };
  async read(): Promise<SpendState> {
    return structuredClone(this.state);
  }
  async readControl(): Promise<SpendControl> {
    return {
      pause: structuredClone(this.state.pause),
      circuits: structuredClone(this.state.circuits ?? {}),
    };
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
  /**
   * The ALL-TIME cumulative charge ceiling (VAL-OPS-002): every settled cost
   * and every not-yet-settled reservation from EVERY day counts against it,
   * so a restart or a midnight rollover can never reopen an exhausted
   * allowance. Optional for backward compatibility — a ledger configured
   * without it keeps its daily-only semantics — but paid graph admission
   * (the research gate) requires it: an unbounded total is not a budget.
   */
  totalMicros?: number;
}
export interface FinishDetails {
  pause?: SpendPause;
  circuit?: { role: ModelRole; reason: RoleCircuit['reason'] };
  requestId?: string | null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class ModelSpendLedger {
  constructor(
    readonly store: SpendStore,
    readonly limits: SpendLimits,
    readonly now = Date.now,
  ) {
    for (const value of Object.values(limits))
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error('Invalid spend limits');
  }
  private async control(): Promise<SpendControl> {
    if (this.store.readControl) return this.store.readControl();
    const s = await this.store.read();
    return { pause: s.pause, circuits: s.circuits ?? {} };
  }
  async status(): Promise<SpendState['pause']> {
    const { pause } = await this.control();
    return pause && (pause.until === null || pause.until > this.now()) ? pause : null;
  }
  /** Open durable role circuit, if any (read-only). */
  async circuit(role: ModelRole): Promise<RoleCircuit | null> {
    return (await this.control()).circuits[role] ?? null;
  }
  /** Spend/allowance check for `micros` more reserved by this job (pause and circuits excluded). */
  private fits(
    s: SpendState,
    day: string,
    identity: Pick<ModelIdentity, 'accountId' | 'jobId'>,
    micros: number,
  ): boolean {
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
    // The all-time cumulative charge (VAL-OPS-002): every attempt's settled
    // cost or outstanding reservation, from every day, plus this one. The
    // ceiling is a hard bound on cumulative spend, so it can never be reopened
    // by a restart or a day rollover.
    const totalExceeded =
      this.limits.totalMicros !== undefined && sum(s.attempts) + micros > this.limits.totalMicros;
    return !(
      totalExceeded ||
      sum(counted) + micros > this.limits.dailyMicros ||
      sum(owned) + micros > this.limits.accountDailyMicros ||
      sum(outstanding) + micros > this.limits.maxUnknownMicros ||
      (!analyses.has(identity.jobId) && analyses.size >= this.limits.accountDailyAnalyses)
    );
  }

  /**
   * Read-only pre-check for a two-stage photo reading (amendment 2.2): true
   * when this job could reserve every listed profile's worst case together
   * right now (no pause, no open circuit, inside the daily, account, unknown
   * and per-account analysis limits). It reserves nothing; each call still
   * reserves its own attempt, so a later refusal is still possible and must
   * leave stage 1 intact.
   */
  async canReserveAll(
    identity: Pick<ModelIdentity, 'accountId' | 'jobId'>,
    profiles: readonly ModelProfile[],
  ): Promise<boolean> {
    if (!identity.accountId || !identity.jobId || !profiles.length) return false;
    const day = utcDay(this.now());
    return this.store.transaction(
      (s) => {
        const now = this.now();
        if (s.pause && (s.pause.until === null || s.pause.until > now)) return false;
        if (profiles.some((p) => s.circuits?.[p.role])) return false;
        return this.fits(
          s,
          day,
          identity,
          profiles.reduce((n, p) => n + p.reservationMicros, 0),
        );
      },
      { day, totalBound: this.limits.totalMicros !== undefined },
    );
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
    const day = utcDay(this.now());
    return this.store.transaction(
      (s) => {
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
        if (s.circuits?.[profile.role])
          throw new ProviderError(
            'model-gateway',
            'unavailable',
            'Model role disabled pending operator review',
          );
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
        if (!this.fits(s, day, identity, profile.reservationMicros)) {
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
          requestId: null,
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
      },
      {
        day,
        totalBound: this.limits.totalMicros !== undefined,
        identity: {
          accountId: identity.accountId,
          jobId: identity.jobId,
          role: profile.role,
          attemptKey: identity.attemptKey,
        },
      },
    );
  }
  async finish(
    id: string,
    outcome: string,
    response?: GatewayResponse,
    details?: SpendPause | FinishDetails,
  ): Promise<void> {
    // Backwards compatible: a bare pause object is still accepted.
    const extra: FinishDetails = !details ? {} : 'reason' in details ? { pause: details } : details;
    await this.store.transaction(
      (s) => {
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
          requestId: response?.requestId ?? extra.requestId ?? null,
        });
        const pause = extra.pause;
        if (pause && (!s.pause || s.pause.until !== null)) {
          // A late 429 completion cannot undo an earlier hard credit/cost pause.
          s.pause = pause;
        }
        if (extra.circuit) {
          s.circuits ??= {};
          s.circuits[extra.circuit.role] ??= { reason: extra.circuit.reason, at: this.now() };
        }
      },
      { day: utcDay(this.now()), attemptId: id },
    );
  }
  /** Operator/billing reconciler only, never called from nullable token usage. Idempotent. */
  async reconcile(id: string, actualCostMicros: number): Promise<void> {
    if (!Number.isSafeInteger(actualCostMicros) || actualCostMicros < 0)
      throw new Error('Invalid actual cost');
    await this.store.transaction(
      (s) => {
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
      },
      { day: utcDay(this.now()), attemptId: id },
    );
  }
  /**
   * Explicit operator action after credits/profile verification, never a paid
   * health probe. Clears the global pause and, when given, role circuits.
   */
  async resume(options: { roles?: ModelRole[] | 'all' } = {}): Promise<void> {
    await this.store.transaction(
      (s) => {
        s.pause = null;
        if (options.roles === 'all') s.circuits = {};
        else for (const role of options.roles ?? []) delete s.circuits?.[role];
      },
      { day: utcDay(this.now()) },
    );
  }
}
