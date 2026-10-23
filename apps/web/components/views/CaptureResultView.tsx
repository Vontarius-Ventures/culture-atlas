'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import type { Category } from '@culture-atlas/domain';
import type { CaptureResponse, Focus, ReferenceSummary } from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '@/lib/client/format';
import { isTerminal, useJob } from '@/lib/client/jobs';
import { UI_LIMITS } from '@/lib/client/limits';
import { cardToTarget, useSave } from '@/lib/client/save';
import { setViewingResult, watchAnalysis } from '@/lib/client/ready';
import { applyOverrides, getCapturePreview, useItemOverrides } from '@/lib/client/store';
import { CardGrid, DiscoveryCard, SkeletonGrid } from '../DiscoveryCard';
import { FilterRow } from '../FilterRow';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { BackLink, Disclosure, MoreMenu, Notice, PageError } from '../ui';
import { ClockIcon } from '../onboarding/parts';
import { WhileWeLook } from '../onboarding/WhileWeLook';
import { COPY } from '../v2/copy';

const DISCOVERY_SECTIONS = ['wear', 'play', 'watch', 'eat'] as const;
const NO_SUBJECT_WARNING = /blur|no_subject|no_useful|unclear|low_quality/i;

export type ResultPhase = 'processing' | 'results' | 'failed';

/** Pure view-state derivation (unit-tested). */
export function deriveCaptureState(
  capture: CaptureResponse | null,
  job: { state: string } | null,
  jobError: boolean,
) {
  const jobActive =
    Boolean(job && !isTerminal(job as never)) || (!job && Boolean(capture?.job_id) && !jobError);
  const sections = capture?.analysis?.sections ?? {};
  const discoveryStatuses = DISCOVERY_SECTIONS.map((s) => sections[s]).filter(Boolean);
  const unfinished = discoveryStatuses.filter(
    (s) => s === 'unavailable' || s === 'failed' || s === 'partial',
  );
  const pending = discoveryStatuses.filter((s) => s === 'pending' || s === 'running');
  const hasResults = (capture?.recommendations.length ?? 0) > 0;
  const failed =
    !jobActive &&
    (job?.state === 'failed' || capture?.status === 'failed') &&
    !hasResults &&
    !capture?.analysis?.title;
  const phase: ResultPhase = failed
    ? 'failed'
    : !capture?.analysis && jobActive
      ? 'processing'
      : !capture?.analysis && !hasResults
        ? jobActive
          ? 'processing'
          : 'results'
        : 'results';
  const noSubject =
    !jobActive &&
    Boolean(capture?.analysis) &&
    (capture!.analysis!.warnings.some((w) => NO_SUBJECT_WARNING.test(w.code)) ||
      (!hasResults && capture!.references.length === 0 && unfinished.length === 0));
  return {
    phase,
    jobActive,
    /** Some categories could not be completed (provider unavailable / failed): one unobtrusive retry. */
    showRetry: !jobActive && unfinished.length > 0,
    /** Still publishing sections. */
    stillLoading: jobActive && (pending.length > 0 || !hasResults),
    noSubject,
  };
}

export function referencePhrase(
  ref: Pick<ReferenceSummary, 'name' | 'qualified' | 'relation'> & Pick<Partial<ReferenceSummary>, 'read_text'>,
): string {
  // A text-only reference is a name read in the photo, not a match or a resemblance.
  if (ref.read_text) return ref.name;
  if (ref.qualified || ref.relation === 'resembles') return `Resembles ${ref.name}`;
  return ref.name;
}

/** Attribution line for a text-only reference: the words it was read from, quoted as written. */
export function readTextAttribution(ref: Pick<Partial<ReferenceSummary>, 'read_text'>): string | null {
  return ref.read_text ? `Read in the photo: “${ref.read_text}”` : null;
}

export function CaptureResultView({ captureId }: { captureId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const { openSave } = useSave();
  const overrides = useItemOverrides();
  const [capture, setCapture] = useState<CaptureResponse | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [jobId, setJobId] = useState<string | null>(search.get('job'));
  const [category, setCategory] = useState<Category | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const preview = getCapturePreview(captureId);

  const load = useCallback(async () => {
    try {
      const res = await api.request('getCapture', { params: { id: captureId } });
      setCapture((prev) => {
        if (prev && prev.recommendations.length === 0 && res.recommendations.length > 0)
          toast.announce(`${res.recommendations.length} discoveries found`);
        return res;
      });
      if (res.job_id) setJobId((j) => j ?? res.job_id);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ApiError
          ? err
          : new ApiError(0, {
              code: 'internal',
              message: 'Something went wrong.',
              retryable: true,
              request_id: 'client',
            }),
      );
    }
  }, [captureId, toast]);

  useAsyncEffect(load, [load]);

  const { job, error: jobError } = useJob(jobId, () => {
    void load();
  });

  const state = deriveCaptureState(capture, job, Boolean(jobError));
  const processingNow = state.phase === 'processing' || !capture;

  // Screen 16: the "While we look" strip appears only for a reading that was
  // running while this page was open, and collapses (never disappears) when
  // the first result section lands, so the results below do not jump.
  const [sawProcessing, setSawProcessing] = useState(false);
  useEffect(() => {
    if (capture && state.phase === 'processing' && !sawProcessing)
      void Promise.resolve().then(() => setSawProcessing(true));
  }, [capture, state.phase, sawProcessing]);

  // Screen 17: remember an analysis this person started, so leaving the page
  // still brings a "Your photo is ready" notice when it finishes.
  const watchKey = `capture:${captureId}`;
  useEffect(() => {
    setViewingResult(watchKey);
    return () => setViewingResult(null);
  }, [watchKey]);
  const watchJob = state.jobActive && capture && !capture.is_example ? (jobId ?? capture.job_id) : null;
  const thumb = capture?.image?.url ?? preview ?? null;
  useEffect(() => {
    if (!watchJob) return;
    watchAnalysis({
      key: watchKey,
      url: `/captures/${captureId}`,
      thumbnail: thumb,
      poll: async () => {
        const j = await api.request('getJob', { params: { id: watchJob } });
        if (!isTerminal(j)) return 'active';
        return j.state === 'complete' || j.state === 'partial' ? 'ready' : 'gone';
      },
    });
  }, [watchJob, watchKey, captureId, thumb]);

  const correct = async (body: {
    focus?: Focus;
    reject_reference_ids?: string[];
    replacement?: { name: string };
  }) => {
    if (!capture?.analysis) return;
    const res = await api.request('correctCapture', {
      params: { id: captureId },
      body: { expected_analysis_version: capture.analysis.version, ...body },
      idempotencyKey: newIdempotencyKey(),
    });
    setJobId(res.job_id);
    toast.announce('Updating your discoveries');
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await correct({ focus: capture?.focus ?? { kind: 'whole' } });
    } catch (err) {
      toast.show({
        message: err instanceof ApiError ? err.message : 'That didn’t work. Try again.',
      });
    } finally {
      setRetrying(false);
    }
  };

  if (loadError && !capture) {
    if (loadError.status === 404) {
      return (
        <div className="page">
          <BackLink href="/" label="Discover" />
          <PageError message="This photo isn’t available. It may have expired or been deleted." />
        </div>
      );
    }
    return (
      <div className="page">
        <PageError message={loadError.message} onRetry={() => void load()} />
      </div>
    );
  }

  const imageUrl = capture?.image?.url ?? preview ?? null;
  const analysis = capture?.analysis ?? null;
  const cards = applyOverrides(capture?.recommendations ?? [], overrides);
  const available = CATEGORY_ORDER.filter((c) => capture?.available_categories.includes(c));
  const filtered = category ? cards.filter((c) => c.category === category) : cards;
  const visible =
    showAll || category ? filtered : filtered.slice(0, UI_LIMITS.initialRenderedRecommendations);
  const processing = state.phase === 'processing';
  const saveInspiration = (el: HTMLButtonElement) => {
    if (!capture?.discovery_item_id) return;
    openSave(
      {
        itemId: capture.discovery_item_id,
        captureId: capture.id,
        title: analysis?.title ?? 'Your photo',
        image: capture.image,
        saved: overrides.get(capture.discovery_item_id)?.saved ?? capture.saved,
      },
      el,
    );
  };
  const inspirationSaved = capture?.discovery_item_id
    ? (overrides.get(capture.discovery_item_id)?.saved ?? capture.saved)
    : false;

  return (
    <div className="page capture-result">
      <div className="page-top">
        <BackLink href="/" label="Discover" />
        {capture && (
          <MoreMenu
            label="More options for this photo"
            items={[
              {
                label: 'Delete photo',
                danger: true,
                onSelect: async () => {
                  if (
                    !window.confirm('Delete this photo and its discoveries? This can’t be undone.')
                  )
                    return;
                  try {
                    await api.request('deleteCapture', {
                      params: { id: captureId },
                      idempotencyKey: newIdempotencyKey(),
                    });
                    toast.show({ message: 'Photo deleted' });
                    router.push('/');
                  } catch (err) {
                    toast.show({
                      message:
                        err instanceof ApiError ? err.message : 'The photo could not be deleted.',
                    });
                  }
                },
              },
            ]}
          />
        )}
      </div>
      <div className="result-head">
        <figure className="result-photo">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={capture?.image?.alt || 'Your photo'}
              className="result-photo__img"
            />
          ) : (
            <div className="result-photo__img result-photo__img--empty" aria-hidden="true" />
          )}
          {capture?.discovery_item_id && !processing && (
            <button
              type="button"
              className={`button button--outline result-photo__save${inspirationSaved ? ' is-saved' : ''}`}
              onClick={(e) => saveInspiration(e.currentTarget)}
            >
              <Icon name={inspirationSaved ? 'bookmarkFilled' : 'bookmark'} />
              <span>{inspirationSaved ? 'Inspiration saved' : 'Save this inspiration'}</span>
            </button>
          )}
        </figure>
        <div className="result-intro">
          {processing || !capture ? (
            <>
              <h1 className="display display--medium">Finding your next favorites…</h1>
              <p className="status-line" role="status">
                <ClockIcon />
                {COPY['while_we_look.status']}
              </p>
            </>
          ) : state.phase === 'failed' ? (
            <>
              <h1 className="display display--medium">
                {job?.error?.code === 'provider_unavailable' || job?.error?.code === 'rate_limited'
                  ? 'We can’t look at this photo yet'
                  : 'We couldn’t read this photo'}
              </h1>
              <Notice tone="error" onRetry={() => void retry()} busy={retrying}>
                {job?.error?.message ?? 'Something went wrong while looking at this photo.'}
              </Notice>
            </>
          ) : (
            <>
              <h1 className="display display--medium">{analysis?.title ?? 'Your photo'}</h1>
              {analysis?.interpretation && <p className="lede">{analysis.interpretation}</p>}
              {capture.references.length > 0 && (
                // Screen 16 mockup: the first references as quiet pills under the reading.
                <ul className="reference-pills" aria-label="References">
                  {capture.references.slice(0, 3).map((ref) => (
                    <li key={ref.id}>
                      {ref.has_page ? (
                        <Link href={`/references/${ref.id}?capture=${captureId}`}>
                          {referencePhrase(ref)}
                        </Link>
                      ) : (
                        <span>{referencePhrase(ref)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {capture?.is_example && <p className="example-label">Example result</p>}
          {state.noSubject && <NoSubject onSubmit={(name) => correct({ replacement: { name } })} />}
          {analysis?.question && !state.jobActive && (
            <FocusQuestion
              question={analysis.question}
              current={capture?.focus ?? null}
              onChoose={(focus) =>
                correct({ focus }).catch((err) =>
                  toast.show({
                    message: err instanceof ApiError ? err.message : 'That didn’t work.',
                  }),
                )
              }
            />
          )}
          {state.jobActive && capture?.analysis && (
            <p className="muted" role="status">
              Updating your discoveries…
            </p>
          )}
          {sawProcessing && (
            <WhileWeLook collapsed={!processingNow} from="discover" />
          )}
        </div>
      </div>

      <section className="result-grid" aria-labelledby="discoveries-heading">
        <h2 id="discoveries-heading" className="section-title">
          Discoveries
        </h2>
        {available.length > 0 && (
          <FilterRow
            label="Filter discoveries"
            options={available.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
            value={category}
            onChange={setCategory}
          />
        )}
        {visible.length > 0 && (
          <CardGrid label="Discoveries from your photo">
            {visible.map((card) => (
              <li key={card.id}>
                <DiscoveryCard
                  card={card}
                  href={`/items/${card.id}?from=capture&capture=${captureId}${card.recommendation_id ? `&rec=${card.recommendation_id}` : ''}`}
                  onSave={(c, el) => openSave(cardToTarget(c), el)}
                />
              </li>
            ))}
          </CardGrid>
        )}
        {(processing || state.stillLoading) && <SkeletonGrid count={processing ? 4 : 2} />}
        {!showAll && !category && filtered.length > UI_LIMITS.initialRenderedRecommendations && (
          <div className="load-more">
            <button
              type="button"
              className="button button--outline"
              onClick={() => setShowAll(true)}
            >
              Load more
            </button>
          </div>
        )}
        {state.showRetry && (
          <Notice onRetry={() => void retry()} busy={retrying}>
            Related discoveries are taking longer.
          </Notice>
        )}
      </section>

      {capture && capture.references.length > 0 && (
        <Disclosure label="Explore the references">
          <ul className="reference-list">
            {capture.references.map((ref) => (
              <li key={ref.id}>
                {ref.has_page ? (
                  <Link
                    href={`/references/${ref.id}?capture=${captureId}`}
                    className="reference-link"
                  >
                    <span>{referencePhrase(ref)}</span>
                    <Icon name="arrowRight" size={16} />
                  </Link>
                ) : (
                  <span className="reference-plain">
                    {referencePhrase(ref)}
                    {readTextAttribution(ref) ? (
                      <span className="reference-source">{readTextAttribution(ref)}</span>
                    ) : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {!correcting ? (
            <button
              type="button"
              className="button button--text"
              onClick={() => setCorrecting(true)}
            >
              Something else?
            </button>
          ) : (
            <Correction
              references={capture.references}
              onCancel={() => setCorrecting(false)}
              onSubmit={async (body) => {
                await correct(body);
                setCorrecting(false);
                toast.show({ message: 'Thanks. Updating your discoveries.' });
              }}
            />
          )}
        </Disclosure>
      )}
    </div>
  );
}

function FocusQuestion({
  question,
  current,
  onChoose,
}: {
  question: NonNullable<NonNullable<CaptureResponse['analysis']>['question']>;
  current: Focus | null;
  onChoose: (focus: Focus) => void;
}) {
  const id = useId();
  const chosen =
    current?.kind === 'choice' ? current.choice_id : current?.kind === 'whole' ? 'whole' : null;
  return (
    <div className="focus-question" role="group" aria-labelledby={id}>
      <p id={id} className="focus-question__prompt">
        {question.prompt || 'What caught your eye?'}
      </p>
      <div className="focus-question__choices">
        {question.choices.map((c) => (
          <button
            key={c.id}
            type="button"
            className="pill"
            aria-pressed={chosen === c.id}
            onClick={() => onChoose({ kind: 'choice', choice_id: c.id, label: c.label })}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          className="pill"
          aria-pressed={chosen === 'whole'}
          onClick={() => onChoose({ kind: 'whole' })}
        >
          The whole photo
        </button>
      </div>
    </div>
  );
}

function NoSubject({ onSubmit }: { onSubmit: (name: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  return (
    <form
      className="no-subject"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setBusy(true);
        try {
          await onSubmit(value.trim());
          setValue('');
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="no-subject__text">Try a clearer photo, or tell us what caught your eye.</p>
      <label htmlFor={id} className="field-label">
        What caught your eye?
      </label>
      <div className="inline-form">
        <input
          id={id}
          className="input"
          value={value}
          maxLength={120}
          onChange={(e) => setValue(e.target.value)}
          placeholder="The striped jacket"
        />
        <button type="submit" className="button button--primary" disabled={busy || !value.trim()}>
          {busy ? 'Sending…' : 'Discover'}
        </button>
      </div>
    </form>
  );
}

function Correction({
  references,
  onSubmit,
  onCancel,
}: {
  references: ReferenceSummary[];
  onSubmit: (body: {
    reject_reference_ids?: string[];
    replacement?: { name: string };
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [rejected, setRejected] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const valid = rejected.length > 0 || name.trim().length > 0;
  return (
    <form
      className="correction"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        setError(null);
        try {
          await onSubmit({
            reject_reference_ids: rejected.length ? rejected : undefined,
            replacement: name.trim() ? { name: name.trim() } : undefined,
          });
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'That didn’t work. Try again.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="correction__refs">
        <legend className="field-label">Which ones aren’t right?</legend>
        {references.map((r) => (
          <label key={r.id} className="check-row">
            <input
              type="checkbox"
              checked={rejected.includes(r.id)}
              onChange={(e) =>
                setRejected((x) => (e.target.checked ? [...x, r.id] : x.filter((y) => y !== r.id)))
              }
            />
            <span>{r.name}</span>
          </label>
        ))}
      </fieldset>
      <label htmlFor={nameId} className="field-label">
        What is it instead? <span className="field-optional">(optional)</span>
      </label>
      <input
        id={nameId}
        className="input"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
      />
      <p className="field-help">Your correction stays private to you.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button button--primary" disabled={!valid || busy}>
          {busy ? 'Sending…' : 'Update discoveries'}
        </button>
        <button type="button" className="button button--text" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
