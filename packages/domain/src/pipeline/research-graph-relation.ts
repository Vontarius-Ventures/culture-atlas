import { AppError } from '../errors';
import { JobCancelledError, type JobContext, type JobHandler } from '../jobs/handler';
import type { JobOutcome } from '../jobs/types';
import { stillOwnsJob } from '../jobs/queue';
import type { ResearchSourceDoc } from '@culture-atlas/providers';
import {
  ensureGraphWorkBudget,
  GraphWorkDeadlineExpiredError,
  graphWorkDeadlineSignal,
  graphWorkWindowEnded,
  isDeadlineCanceledStatement,
  isGraphWorkDeadlineOutcome,
  setGraphWorkBudgetState,
  stopGraphWorkBudgetIfExpired,
  type GraphWorkBudgetState,
} from '../interest-graph/budgets';
import { INTEREST_GRAPH_POLICY_VERSION, type GraphPredicate, type GraphRunRow } from '../interest-graph/schema';
import { graphDiscoveryPausedAt, lockAccountPublicationAuthority } from '../interest-graph/refresh';
import { currentAccountAuthorityVersions, lockAccountAuthorityVersions } from '../interest-graph/expansion';
import {
  buildRelationResearchRequest,
  proposeResearchAssertions,
  RESEARCH_MAX_PROPOSED_ASSERTIONS,
  RESEARCH_MAX_SOURCE_DOCUMENTS,
  isApprovedResearchUrl,
  type ResearchProposalEvidenceInput,
  type ResearchSourceInput,
} from '../interest-graph/research';
import { researchDispatchGate } from '../interest-graph/research-gate';
import { createGraphRun, graphRunForJob, recordGraphProviderQuery, setGraphRunState } from '../interest-graph/store';

/**
 * Queue handler for `research_graph_relation` (PR 8, VAL-DISC-005/007).
 *
 * One bounded relation-research pair: the public-only request (canonical
 * names/ids, never photos, account identity or private history) is evaluated
 * against at most two approved source documents; citing claims become the
 * machine-extraction evidence of at most ten proposed assertions. Proposals
 * are stored as UNREVIEWED `proposed` assertions — validation is the separate
 * review gate, never this job.
 *
 * The PAID call (the research claims model) is fail-closed behind the same
 * gate as dispatch: research flag, no kill, no pause, a compatible qualified
 * role and durable account/global spend limits. The call itself flows through
 * the real provider stack, so the gateway's durable ledger reserves and
 * settles it. The paid extraction runs inside ctx.runStage, so a retry after
 * a lost lease reuses the completed output instead of re-buying it.
 *
 * A redelivery of a COMMITTED pass reuses the run instead of re-running it
 * (the same committed-run reuse the expansion handler performs): the pass's
 * publication — the proposed assertions, or the honest empty-sources lookup —
 * commits with the run's 'complete' state, and the budget close and the job
 * completion after it are bookkeeping. A worker that dies between that commit
 * and the queue acknowledgment leaves a complete run that the redelivery
 * returns as-is: no re-open, no re-anchored spend, no provider call, no
 * republish — inside OR past the original 45-second window, whose complete
 * row stays exactly as the pass left it.
 *
 * The storage transaction is fenced and ORDERED (VAL-DISC-007,
 * DISC-SCR-008/011/021): its first statement takes the consistent per-account
 * publication-authority lock (the same row lock pause/resume take) and holds it
 * through the commit, so a pause cannot land between the fence's checks and
 * the publication. Inside that lock the fence rechecks account existence, the
 * discovery pause, the CURRENT taste/projection/deletion-generation versions
 * against the ORIGINAL input versions the run captured at first-attempt start
 * (a save/removal, projection pass or deletion generation during the held paid
 * call — or since a crashed attempt whose extraction is being replayed —
 * rejects publication), the lease and the durable logical deadline. The
 * version comparison itself is a LOCKED read of the rows the actual writers
 * update (the taste row, materialized when absent, and the projection state
 * row) held through the commit, so a writer commits before the comparison
 * (rejected) or queues for the publication commit — it can no longer slip
 * between the comparison and the storage commit (DISC-SCR-021). Rejected
 * work is discarded; the spend stays accounted; nothing is published.
 *
 * The anchored logical window spans the WHOLE attempt (VAL-DISC-006,
 * DISC-SCR-018/019), not merely individual statement timeouts or the first
 * lookup: every source lookup is gated on the original remaining window and
 * receives the anchored combined signal (so an in-flight search aborts at the
 * deadline and a second request never starts after it), and an empty result
 * completing past the window reports as the typed logical-deadline outcome
 * instead of a completed lookup. In the storage pass every statement and lock
 * wait is bounded by the CURRENT remainder — refreshed between stages, so two
 * individually short waits cannot cumulatively outrun the anchor — and the
 * durable window is decided again after all writes, before the transaction
 * completes.
 */

/** Maps an approved research URL to its durable-rights provider policy key. */
function researchProviderForUrl(url: string): 'wikipedia' | 'wikidata' | 'artic_open_access' {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'wikidata.org' || host.endsWith('.wikidata.org')) return 'wikidata';
  if (host === 'artic.edu' || host.endsWith('.artic.edu')) return 'artic_open_access';
  return 'wikipedia';
}

export const researchGraphRelation: JobHandler<'research_graph_relation'> = async (
  ctx: JobContext<'research_graph_relation'>,
): Promise<JobOutcome> => {
  const accountId = ctx.job.owner_account_id;
  if (!accountId || ctx.payload.account_id !== accountId) {
    throw new AppError('invalid_input', { message: 'Relation research requires its owning account.', retryable: false });
  }
  await ctx.ensureActive();

  // The durable budget of the logical research item: research makes NO Qloo
  // calls (allowance 0, so any accidental Qloo usage in this path is refused)
  // and anchors its logical deadline so redelivery cannot reset it.
  const workKey = ctx.job.dedupe_key ?? `research:${ctx.job.id}`;

  // At-least-once redelivery of a COMMITTED pass (the same crash boundary the
  // expansion handler owns): the pass's publication — the proposed
  // assertions, or the honest empty-sources lookup — commits with the run's
  // 'complete' state, and the budget close and the job completion after it
  // are bookkeeping. A worker that dies between that commit and the queue
  // acknowledgment leaves the job 'running' with a lease and a COMMITTED
  // complete run, and a redelivery must REUSE it: the complete budget is not
  // an active window (its durable ended-check reports the window over), so
  // re-running the pass would reopen the committed run, re-invoke providers
  // and republish — and past the 45-second anchor the entry check would
  // overwrite the complete window as stopped and falsely fail the finished
  // job. Reuse instead: no re-open, no re-anchored spend, no provider call, no
  // republish — the original run's result.
  const priorRun = await graphRunForJob(ctx.db, { ownerAccountId: accountId, jobId: ctx.job.id });
  if (priorRun && priorRun.state === 'complete') {
    // Finish the committed pass's bookkeeping idempotently: the window closes
    // (state only — the deadline columns are never rewritten, so an
    // already-complete window keeps its exact anchor) if the crash interrupted
    // it, and an already-complete row stays complete.
    await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'complete' });
    await ctx.trace({ kind: 'note', name: 'graph_research_redelivery_reused', data: { run_id: priorRun.id } });
    return { state: 'complete', resultType: 'graph_research', resultId: priorRun.id };
  }

  // The dispatch gate, re-checked at run time: a gate that closed between
  // dispatch and run refuses honestly, before any paid call.
  const gate = await researchDispatchGate(ctx.db, {
    accountId,
    config: ctx.config,
    providers: ctx.providers,
  });
  if (!gate.allowed) {
    if (gate.reason === 'paused') {
      await ctx.trace({ kind: 'note', name: 'graph_research_skipped', data: { reason: gate.reason } });
      return { state: 'complete', resultType: 'graph_research' };
    }
    throw new AppError('service_unavailable', {
      message: 'Relation research is not available on this server.',
      retryable: false,
      details: { rule: gate.reason },
    });
  }

  // Deletion fence: jobs cascade with the account, but a claimed job can race
  // deletion; the storage fence re-checks inside its transaction as well.
  const { rows: accountRows } = await ctx.db.query<{ id: string }>('SELECT id FROM accounts WHERE id = $1', [accountId]);
  if (accountRows.length === 0) return { state: 'complete', resultType: 'graph_research' };

  const budget: GraphWorkBudgetState = await ensureGraphWorkBudget(ctx.db, {
    ownerAccountId: accountId,
    workKind: 'research',
    workKey,
    qlooAttemptsMax: 0,
  });
  if (budget.deadlineExpired) {
    await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'stopped' });
    throw new AppError('service_unavailable', {
      message: 'This relation-research window expired; a new one is on the way.',
      retryable: false,
      details: { rule: 'logical_deadline_expired' },
    });
  }

  // The remaining logical window governs every stage of this attempt
  // (VAL-DISC-006), not just the entry check above: each provider boundary
  // re-reads the durable row and refuses once the anchored deadline passed —
  // a delayed first claim or a redelivery never gets a fresh 45 seconds.
  const windowLive = async (): Promise<GraphWorkBudgetState> => {
    const live = await ensureGraphWorkBudget(ctx.db, { ownerAccountId: accountId, workKind: 'research', workKey, qlooAttemptsMax: 0 });
    if (live.deadlineExpired) {
      await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'stopped' });
      throw new AppError('service_unavailable', {
        message: 'This relation-research window expired; a new one is on the way.',
        retryable: false,
        details: { rule: 'logical_deadline_expired' },
      });
    }
    return live;
  };

  // The anchored combined signal spans EVERY bounded provider stage of this
  // attempt (DISC-SCR-019): both source lookups and the paid extraction
  // receive it, so an in-flight call is aborted at the ORIGINAL deadline
  // (never a fresh per-attempt one), and the worker's own grant (lease loss,
  // cancellation) aborts it too — whichever comes first.
  const window = graphWorkDeadlineSignal(budget.deadlineAt, ctx.signal);
  // The remaining window a provider stage may still use as its own bound.
  const remainingTimeoutMs = (live: GraphWorkBudgetState) => Math.max(1, live.deadlineAt.getTime() - Date.now());

  // Public-only request: canonical names/ids of the shared identity layer.
  const request = await buildRelationResearchRequest(ctx.db, {
    subjectNodeId: ctx.payload.subject_node_id,
    objectNodeId: ctx.payload.object_node_id,
    predicate: ctx.payload.predicate as GraphPredicate,
  });

  // DISC-SCR-011: the run row is ONE per job (job_id is unique), and with it
  // the ORIGINAL input authority versions of the logical research item: they
  // are captured at the FIRST attempt's run start — before the paid extraction
  // — persisted on the run, and reused verbatim by every later redelivery
  // (which replays the stored extraction), never re-read fresh at a
  // redelivery's callback entry. The storage fence below compares CURRENT
  // versions against that original capture before any write. (A prior run
  // already in state 'complete' never reaches here: the committed-run reuse
  // above returned it instead, so this branch only serves the not-yet-
  // committed shapes — a first attempt, or a redelivery of a failed run.)
  let run: GraphRunRow;
  if (priorRun) {
    // A redelivery of an attempt that already created the job's run: reuse
    // the run row and its ORIGINAL input versions; a second run row for the
    // job is impossible by the unique key.
    run = priorRun;
  } else {
    const captured = await currentAccountAuthorityVersions(ctx.db, accountId);
    run = await createGraphRun(ctx.db, {
      ownerAccountId: accountId,
      runKind: 'research',
      jobId: ctx.job.id,
      inputTasteRevision: captured.tasteRevision,
      inputProjectionRevision: captured.projectionRevision,
      inputGeneration: captured.generation,
      policyVersion: INTEREST_GRAPH_POLICY_VERSION,
      budget: {
        source: 'relation_research',
        predicate: ctx.payload.predicate,
        bounds: {
          max_source_documents: RESEARCH_MAX_SOURCE_DOCUMENTS,
          max_proposed_assertions: RESEARCH_MAX_PROPOSED_ASSERTIONS,
        },
      },
    });
  }
  // The ORIGINAL input versions of the logical item (the run row's).
  const inputAuthority = {
    tasteRevision: run.input_taste_revision,
    projectionRevision: run.input_projection_revision,
    generation: run.input_generation,
  };
  await setGraphRunState(ctx.db, { runId: run.id, ownerAccountId: accountId, state: 'running' });

  try {
    // --- Bounded sources: subject first, object second, two total, URL-gated.
    const kept: ResearchSourceDoc[] = [];
    const sourcesIn: ResearchSourceInput[] = [];
    const seenUrls = new Set<string>();
    const take = (doc: ResearchSourceDoc) => {
      if (kept.length >= RESEARCH_MAX_SOURCE_DOCUMENTS) return false;
      if (!isApprovedResearchUrl(doc.url) || seenUrls.has(doc.url)) return false;
      seenUrls.add(doc.url);
      kept.push(doc);
      const provider = researchProviderForUrl(doc.url);
      const license = doc.license ?? 'See source license';
      sourcesIn.push({
        key: `s${kept.length - 1}`,
        provider,
        url: doc.url,
        title: doc.title,
        publisher: doc.publisher,
        attribution: doc.publisher,
        license,
        // One source family per canonical URL: mirrors and re-crawls of the
        // same document count as one family, never independent corroboration.
        sourceFamilyKey: `research:${doc.url}`,
        rights: { license, permitted_use: ['storage', 'display'], expiry: 'none', basis: `${provider} provider rights policy` },
        retrievedAt: new Date(doc.retrieved_at),
      });
      return true;
    };
    const subjectWindow = await windowLive();
    const subjectDocs = await ctx.providers.research.findSources(
      {
        name: request.subject.canonicalName,
        type: request.subject.nodeKind,
        limit: RESEARCH_MAX_SOURCE_DOCUMENTS,
      },
      { signal: window.signal, timeoutMs: remainingTimeoutMs(subjectWindow) },
    );
    for (const doc of subjectDocs) take(doc);
    if (request.object && kept.length < RESEARCH_MAX_SOURCE_DOCUMENTS) {
      // The SECOND lookup checks the window first (DISC-SCR-019): a first
      // search that outlived the anchor never starts another request, and
      // the budget stops honestly at this boundary.
      const objectWindow = await windowLive();
      const objectDocs = await ctx.providers.research.findSources(
        {
          name: request.object.canonicalName,
          type: request.object.nodeKind,
          limit: RESEARCH_MAX_SOURCE_DOCUMENTS - kept.length,
        },
        { signal: window.signal, timeoutMs: remainingTimeoutMs(objectWindow) },
      );
      for (const doc of objectDocs) take(doc);
    }
    if (kept.length === 0) {
      // No approved source: research records nothing and invents nothing —
      // but only while the window is still live (DISC-SCR-019): an empty
      // result that completed past the anchored deadline is NOT a completed
      // lookup. The elapsed work reports as the typed logical-deadline
      // outcome instead, the window stops honestly, and nothing is recorded
      // as a completed empty search.
      await windowLive();
      await recordGraphProviderQuery(ctx.db, {
        ownerAccountId: accountId,
        runId: run.id,
        provider: 'research',
        operation: 'find_sources',
        sanitizedRequest: { subject: request.subject.canonicalKey, object: request.object?.canonicalKey ?? null },
        results: { sources: 0 },
        status: 'empty',
        traceId: ctx.job.trace_id ?? undefined,
      });
      await setGraphRunState(ctx.db, { runId: run.id, ownerAccountId: accountId, state: 'complete' });
      // The logical item is finished: close its durable budget window so a
      // completed pass never lingers in the ops metrics as a stuck window
      // (the same close the expansion pass runs after publication). The
      // deadline anchor, not the state, governs any later redelivery.
      await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'complete' });
      return { state: 'complete', resultType: 'graph_research', resultId: run.id };
    }

    // --- The paid extraction, stage-wrapped: a retry reuses the completed
    // output instead of re-buying it. The window must still be live BEFORE the
    // paid call, and the call itself cannot outlive the window: the anchored
    // combined signal (created above, spanning every bounded stage) aborts at
    // the original deadline — a redelivery's fresh per-attempt deadline never
    // extends it.
    const liveBeforeExtraction = await windowLive();
    const extraction = await ctx.runStage('research:extract', () =>
      ctx.providers.research.extractClaims(
        {
          name: request.subject.canonicalName,
          type: request.subject.nodeKind,
          sources: kept,
          maxClaims: RESEARCH_MAX_PROPOSED_ASSERTIONS,
        },
        { signal: window.signal },
      ),
    );
    await ctx.ensureActive();
    await recordGraphProviderQuery(ctx.db, {
      ownerAccountId: accountId,
      runId: run.id,
      provider: 'research',
      operation: 'extract_claims',
      sanitizedRequest: {
        subject: request.subject.canonicalKey,
        object: request.object?.canonicalKey ?? null,
        predicate: ctx.payload.predicate,
        grammar_version: request.grammarVersion,
        sources: kept.map((d) => d.url),
      },
      results: { claims: extraction.claims.length, overview_words: extraction.overview.trim().split(/\s+/).length },
      status: 'ok',
      traceId: ctx.job.trace_id ?? undefined,
    });

    // --- Citing claims become the machine-extraction evidence of ONE proposed
    // assertion (the researched pair). Interpretive or uncited claims ground
    // nothing and are counted honestly instead.
    const urlToSourceKey = new Map(kept.map((d, i) => [d.url, `s${i}`]));
    const evidence: ResearchProposalEvidenceInput[] = [];
    let droppedInterpretive = 0;
    let droppedUncited = 0;
    for (const claim of extraction.claims) {
      if (claim.claim_type !== 'factual') {
        droppedInterpretive++;
        continue;
      }
      const cited = claim.source_urls.filter((u) => urlToSourceKey.has(u));
      if (cited.length === 0) {
        droppedUncited++;
        continue;
      }
      evidence.push({
        sourceKey: urlToSourceKey.get(cited[0]!)!,
        excerpt: claim.text,
        evidenceKind: 'fact',
        validationVersion: 'research-text-1',
      });
      if (evidence.length >= RESEARCH_MAX_PROPOSED_ASSERTIONS) break;
    }
    const proposals =
      evidence.length > 0
        ? [
            {
              subjectNodeId: ctx.payload.subject_node_id,
              predicate: ctx.payload.predicate as GraphPredicate,
              objectNodeId: ctx.payload.object_node_id,
              associationSubtype: ctx.payload.association_subtype ?? null,
              evidence,
            },
          ]
        : [];

    // --- Fenced storage: publication rechecks current authority inside the
    // transaction, so delayed work after deletion, pause, lease loss — or
    // after its own LOGICAL DEADLINE (VAL-DISC-006) — publishes nothing (the
    // paid call stays accounted, the work is discarded). The storage pass
    // honors the ABSOLUTE window through its stages (DISC-SCR-018): each
    // statement and lock wait is bounded by the CURRENT remainder (refreshed
    // between stages, so successive waits cannot cumulatively outrun the
    // anchor), and the durable window is re-checked after all writes, before
    // the transaction completes.
    let stored: Awaited<ReturnType<typeof proposeResearchAssertions>>;
    try {
      stored = await proposeResearchAssertions(ctx.db, {
        sources: sourcesIn,
        proposals,
        deadline: {
          at: liveBeforeExtraction.deadlineAt,
          ended: (tx) => graphWorkWindowEnded(tx, { ownerAccountId: accountId, workKey }),
        },
        fence: async (tx, bound) => {
          // The per-account publication-authority lock (DISC-SCR-008), acquired
          // FIRST and held through this transaction's commit: the same row lock
          // pause/resume take, so a pause either commits before this read
          // (rejected just below) or waits for the publication commit — it can
          // no longer slip between the check and the commit. The lock never
          // blocks projection or support removal (foreign-key key-share work).
          // DISC-SCR-025: this is the fence's FIRST lock wait — it re-tightens
          // the SQL bound to the CURRENT remainder right before parking.
          await bound();
          if (!(await lockAccountPublicationAuthority(tx, accountId))) throw new JobCancelledError('account deleted');
          if ((await graphDiscoveryPausedAt(tx, accountId)) != null) {
            throw new AppError('conflict', { message: 'Discovery is paused; research cannot publish.', retryable: false });
          }
          // The ROLLBACK gate re-runs at publication (VAL-OPS-001): a flag
          // kill — global or account-scoped — that landed while the paid
          // extraction ran still publishes nothing. The durable kill state is
          // re-read inside this publication transaction (READ COMMITTED: a
          // kill that committed mid-extraction is visible here), never cached
          // from dispatch or entry. The paid provider query stays accounted;
          // the work is discarded; the job fails non-retryably with the
          // disabled rule.
          const rollback = await researchDispatchGate(tx, {
            accountId,
            config: ctx.config,
            providers: ctx.providers,
          });
          if (!rollback.allowed) {
            throw new AppError('service_unavailable', {
              message: 'Relation research is not available on this server.',
              retryable: false,
              details: { rule: 'disabled' },
            });
          }
          // The extraction ran under the ORIGINAL input versions (DISC-SCR-011):
          // a taste change (a save/removal), a projection pass or an advanced
          // deletion generation since means this delayed work is stale against
          // current authority and publishes nothing. This holds across the held
          // paid call AND across redelivery replays of a stored extraction.
          // The comparison is a LOCKED read of the exact rows the real writers
          // update (DISC-SCR-021), held through this transaction's commit —
          // an absent taste row is materialized so the FIRST save is ordered
          // too, and the projector's pass takes this same fence's account-row
          // lock before it can create or bump the state row — so a writer
          // commits before the read (rejected here) or queues for the storage
          // commit: it can no longer land between the comparison and the
          // commit, and the run's original input versions are never rewritten
          // by the guard. DISC-SCR-025: the version locks are this fence's
          // LATER, independent waits — each one re-tightens to the CURRENT
          // remainder inside lockAccountAuthorityVersions too, so the time the
          // account wait consumed above cannot widen them past the anchor.
          const current = await lockAccountAuthorityVersions(tx, accountId, bound);
          if (
            current.tasteRevision !== inputAuthority.tasteRevision ||
            current.projectionRevision !== inputAuthority.projectionRevision ||
            current.generation !== inputAuthority.generation
          ) {
            throw new AppError('conflict', {
              message: 'This relation research landed behind a newer change; retrying from current state.',
              retryable: false,
              details: { rule: 'stale_authority' },
            });
          }
          if (!(await stillOwnsJob(tx, ctx.job.id, ctx.workerId, ctx.attempt))) throw new JobCancelledError('lease lost');
          // The durable deadline, re-read with the transaction's own clock: a
          // delayed extraction or SQL/lock wait cannot commit past the anchor.
          if (await graphWorkWindowEnded(tx, { ownerAccountId: accountId, workKey })) {
            throw new GraphWorkDeadlineExpiredError();
          }
        },
      });
    } catch (err) {
      // The storage pass's SQL and lock waits are bounded by the window's
      // CURRENT remaining time (refreshed at each stage), and that bound IS
      // the deadline: PostgreSQL cancels a statement past it with code 57014
      // (VAL-DISC-006) — possibly BEFORE the fence's typed window check above
      // could run. Such a cancel is the same deadline fact and must surface
      // as the typed terminal outcome, never a raw database error — but only
      // when the durable window really ended: a still-live window means the
      // cancel was not this deadline, and the raw error stays exactly what it
      // is.
      if (isDeadlineCanceledStatement(err) && (await graphWorkWindowEnded(ctx.db, { ownerAccountId: accountId, workKey }))) {
        throw new GraphWorkDeadlineExpiredError();
      }
      throw err;
    }

    await setGraphRunState(ctx.db, { runId: run.id, ownerAccountId: accountId, state: 'complete' });
    // Same honest close as the empty-sources path above: the window is spent.
    await setGraphWorkBudgetState(ctx.db, { ownerAccountId: accountId, workKey, state: 'complete' });
    await ctx.trace({
      kind: 'note',
      name: 'graph_research_proposed',
      data: {
        run_id: run.id,
        sources: stored.sources.length,
        proposed: stored.proposed.length,
        rejected: stored.rejected.length,
        dropped_interpretive: droppedInterpretive,
        dropped_uncited: droppedUncited,
      },
    });
    return { state: 'complete', resultType: 'graph_research', resultId: run.id };
  } catch (err) {
    // The run record is lineage, not authority: a failed attempt leaves an
    // honest failed run (and the paid provider query recorded above stays).
    // A window that ended while the attempt ran is durably stopped here, so
    // no later redelivery can re-open the spent window (VAL-DISC-006).
    await setGraphRunState(ctx.db, { runId: run.id, ownerAccountId: accountId, state: 'failed' }).catch(() => undefined);
    await stopGraphWorkBudgetIfExpired(ctx.db, { ownerAccountId: accountId, workKey }).catch(() => undefined);
    // The rollback gate's refusal is a first-class telemetry event (VAL-OPS-003):
    // a kill that stopped publication after the paid call is visible as
    // graph_research_disabled alongside the accounted provider query.
    if (err instanceof AppError && (err.details as { rule?: unknown } | undefined)?.rule === 'disabled') {
      await ctx.trace({ kind: 'note', name: 'graph_research_disabled', data: { rule: 'disabled' } });
    }
    // DISC-SCR-026: classify a provider abort CAUSED by the expired durable
    // window as the typed logical-deadline outcome. The combined window signal
    // aborts on its own exactly when the anchored deadline passes (the
    // worker's own grant — lease loss, cancellation, the per-attempt timer —
    // would have aborted ctx.signal first), so an attempt error surfacing
    // with that signal fired and the worker still live is the deadline
    // itself ending the in-flight source lookup or paid extraction — a real
    // adapter reports it as ProviderError('research','aborted'), which the
    // production Worker would otherwise misclassify as retryable
    // provider_unavailable. The typed outcome is non-retryable and matches
    // what the next redelivery of this expired window would report anyway.
    // Genuine worker/lease cancellation (ctx.signal aborted) and still-live
    // provider failures (the window signal never fired) keep their own
    // classifications, and an error that is already the typed outcome keeps
    // its exact identity.
    if (window.signal.aborted && !ctx.signal.aborted && !isGraphWorkDeadlineOutcome(err)) {
      throw new GraphWorkDeadlineExpiredError();
    }
    throw err;
  } finally {
    window.dispose();
  }
};
