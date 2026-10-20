import type { ReactNode } from 'react';
import type { TraceResponse } from '@culture-atlas/domain/schemas';
import styles from './inspector.module.css';

/**
 * Demo inspector ("Show how it works"). Developer/demo-owner view of one job:
 * the photo, visual observations, resolved provider ids, provider queries with
 * their inputs and ranked results, sourced references, recommendations with
 * provenance, saved taste changes and the separate agent's service calls.
 * Unlike consumer screens this view intentionally shows provider names, ids
 * and scores. It is never linked from the consumer flow.
 */

const JOB_LABEL: Record<string, string> = {
  analyze_capture: 'Photo analysis',
  discover_related: 'Related discovery',
  generate_plan: 'Movie night plan',
  replace_plan_section: 'Plan section replacement',
  sensor_poll: 'Sensor import',
  purge_deleted: 'Purge',
};

const ORIGIN_LABEL: Record<string, string> = {
  qloo: 'Qloo result',
  research: 'Sourced research',
  catalog: 'Catalog',
  vlm_creative: 'Creative suggestion (not from Qloo)',
  sample: 'Example result',
  replay: 'Example result (replayed)',
};

function time(at: string | null): string {
  if (!at) return '—';
  return new Date(at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function Json({ value }: { value: unknown }) {
  return <pre className={styles.json}>{JSON.stringify(value, null, 2)}</pre>;
}

function Section({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.sectionTitle}>
        {title}
        {count !== undefined ? <span className={styles.count}>{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

/**
 * Plain reasons for the guard and verifier decision notes (the reason codes
 * recorded in the analysis trace, docs/quality-plan.md §2). Unknown codes are
 * shown verbatim.
 */
export const DECISION_NOTE_LABEL: Record<string, string> = {
  single_read_text_only: 'Text-only reference: the name was read only in the second reading, so it is listed with that text and never looked up',
  not_read_at_stage_2: 'Dropped: the name was not transcribed in the photo',
  held_at_stage_2: 'Dropped: still unconfirmed after the second reading',
  no_confirmation: 'Dropped: the second reading did not confirm it',
  unsupported: 'Dropped: the second reading did not support it',
  weak: 'Weak support from the second reading',
  'weak: resembles, non-anchor': 'Weak support: shown as a resemblance, never a signal',
  no_stage_2: 'Dropped: no second reading to confirm it',
  duplicate: 'Dropped: same name as another reference',
  replaced_by_tag_query: 'Replaced by the style it names',
  style_of_attribution: 'Dropped: attributes a style to a named person',
  // guard-v8 / vlm-verify-v3 (requalification round 3): withheld claims stay here only, as private observations.
  context_only: 'Kept private: rests only on context, with nothing to confirm it',
  people_claim: 'Kept private: a claim about the people in the photo that no text in it backs',
  read_maker_text_only: 'Text-only reference: the maker is read in the photo, the full model name is not',
  // guard-v11 (round 4): hold until confirmed, read model, a work named by its form.
  held_people_present: 'Held for the second reading: a style or tradition on a photo with people',
  held_context_only: 'Held for the second reading: rests only on context',
  read_model_text_only: 'Text-only reference: the model name is read in the photo, the maker is not',
  work_title_by_form: 'Shown after the second reading supported it: a well-known work named by its form',
  verifier_no: 'Verifier: not supported by the photo; not shown',
  verifier_unsure: 'Verifier: unsure; not shown',
  verifier_unanswered: 'Verifier: no answer for this claim; not shown',
  verifier_yes: 'Verifier: supported; shown',
};

export interface ReadingDecisionRow {
  stage: string;
  name: string;
  action: string;
  rules: string[];
  note: string | null;
  reason: string | null;
}

/** Guard (stage 1, stage 2) and verifier decisions from the pipeline events, in order. */
export function readingDecisions(events: TraceResponse['events']): ReadingDecisionRow[] {
  const rows: ReadingDecisionRow[] = [];
  for (const e of events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const list = e.name === 'guard' ? data.decisions : e.name === 'verify' ? data.checks : null;
    if (!Array.isArray(list)) continue;
    const stage = e.name === 'verify' ? 'verifier' : `stage ${String(data.stage ?? '?')}`;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      const note = typeof d.note === 'string' ? d.note : typeof d.answer === 'string' ? `verifier_${d.answer}` : null;
      rows.push({
        stage,
        name: typeof d.name === 'string' ? d.name : '—',
        action: typeof d.action === 'string' ? d.action : '—',
        rules: Array.isArray(d.rules) ? d.rules.filter((r): r is string => typeof r === 'string') : e.name === 'verify' ? ['V-CHECK'] : [],
        note,
        reason: note ? (DECISION_NOTE_LABEL[note] ?? note) : null,
      });
    }
  }
  return rows;
}

function observationText(o: unknown): { label: string; detail: string | null } {
  if (o && typeof o === 'object') {
    const r = o as Record<string, unknown>;
    const label = [r.label, r.name, r.text, r.description, r.title].find((v) => typeof v === 'string') as string | undefined;
    const detailParts = [r.kind, r.type, r.category].filter((v) => typeof v === 'string') as string[];
    if (typeof r.certainty === 'number') detailParts.push(`certainty ${r.certainty.toFixed(2)}`);
    if (label) return { label, detail: detailParts.join(' · ') || null };
  }
  return { label: typeof o === 'string' ? o : JSON.stringify(o), detail: null };
}

export function InspectorView({ trace }: { trace: TraceResponse }) {
  const decisions = readingDecisions(trace.events);
  const qlooQueries = trace.provider_queries.filter((q) => q.provider === 'qloo');
  const liveQloo = qlooQueries.filter((q) => q.status === 'ok' && !q.is_replay).length;
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>culture atlas · how it works</p>
        <h1 className={styles.title}>{JOB_LABEL[trace.job.type] ?? trace.job.type}</h1>
        <dl className={styles.meta}>
          <div>
            <dt>Job</dt>
            <dd className={styles.mono}>{trace.job.id}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{trace.job.state}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{time(trace.job.created_at)}</dd>
          </div>
          <div>
            <dt>Finished</dt>
            <dd>{time(trace.job.finished_at)}</dd>
          </div>
          <div>
            <dt>Qloo queries</dt>
            <dd>
              {liveQloo} live of {qlooQueries.length}
            </dd>
          </div>
        </dl>
        <p className={styles.note}>Developer view. Tokens, credentials and private deployment details are redacted.</p>
      </header>

      <div className={styles.grid}>
        <div className={styles.column}>
          {trace.capture ? (
            <Section id="photo" title="Photo">
              {trace.capture.image ? (
                // Short-lived signed URL for the owner's private photo (plain img: no image optimizer cache).
                <img className={styles.photo} src={trace.capture.image.url} alt={trace.capture.image.alt || 'The analyzed photo'} />
              ) : (
                <Empty>The photo is no longer stored.</Empty>
              )}
            </Section>
          ) : null}

          {trace.plan ? (
            <Section id="plan" title="Plan inputs" count={trace.plan.inputs.length}>
              <p className={styles.small}>
                {trace.plan.title ?? 'Untitled plan'} · version {trace.plan.version ?? '—'}
                {trace.plan.section ? ` · replaced section: ${trace.plan.section}` : ''}
              </p>
              <ul className={styles.list}>
                {trace.plan.inputs.map((i) => (
                  <li key={i.item_id}>
                    {i.title} <span className={styles.tag}>{i.kind}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {trace.related_origin ? (
            <Section id="origin" title="Explored from">
              <p>
                {trace.related_origin.title} <span className={styles.tag}>{trace.related_origin.kind}</span>
              </p>
            </Section>
          ) : null}

          <Section id="observations" title="Visual observations" count={trace.observations.length}>
            {trace.observations.length === 0 ? (
              <Empty>No visual observations for this job.</Empty>
            ) : (
              <ul className={styles.list}>
                {trace.observations.map((o, i) => {
                  const { label, detail } = observationText(o);
                  return (
                    <li key={i}>
                      {label}
                      {detail ? <span className={styles.small}> · {detail}</span> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {decisions.length > 0 ? (
            <Section id="decisions" title="Reading decisions" count={decisions.length}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Claim</th>
                    <th scope="col">Decision</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d, i) => (
                    <tr key={i}>
                      <td>
                        {d.name}
                        <span className={styles.small}> · {d.stage}</span>
                      </td>
                      <td>
                        {d.action}
                        {d.rules.length ? <span className={`${styles.small} ${styles.mono}`}> · {d.rules.join(', ')}</span> : null}
                      </td>
                      <td>{d.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          ) : null}

          <Section id="entities" title="Resolved IDs" count={trace.resolved_entities.length}>
            {trace.resolved_entities.length === 0 ? (
              <Empty>Nothing was resolved to a provider id.</Empty>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Provider</th>
                    <th scope="col">ID</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.resolved_entities.map((e) => (
                    <tr key={`${e.provider}:${e.provider_id}:${e.reference_id ?? ''}`}>
                      <td>
                        {e.name}
                        {e.type ? <span className={styles.small}> · {e.type}</span> : null}
                      </td>
                      <td>{e.provider}</td>
                      <td className={styles.mono}>{e.provider_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section id="references" title="Sourced references" count={trace.references.length}>
            {trace.references.length === 0 ? (
              <Empty>No references for this job.</Empty>
            ) : (
              <ul className={styles.list}>
                {trace.references.map((r) => (
                  <li key={r.id}>
                    {r.name}{' '}
                    <span className={styles.small}>
                      · {r.claim_count} claim{r.claim_count === 1 ? '' : 's'}, {r.source_count} source{r.source_count === 1 ? '' : 's'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="taste" title="Saved taste changes" count={trace.taste_changes.length}>
            {trace.taste_changes.length === 0 ? (
              <Empty>No saves, hides or removals on these items.</Empty>
            ) : (
              <ul className={styles.list}>
                {trace.taste_changes.map((t, i) => (
                  <li key={i}>
                    <span className={styles.tag}>{t.action}</span> <span className={styles.mono}>{t.target_id}</span>{' '}
                    <span className={styles.small}>· {time(t.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className={styles.column}>
          <Section id="queries" title="Provider queries" count={trace.provider_queries.length}>
            {trace.provider_queries.length === 0 ? (
              <Empty>No provider queries were made.</Empty>
            ) : (
              <ol className={styles.queries}>
                {trace.provider_queries.map((q) => (
                  <li key={q.id} className={styles.query}>
                    <details>
                      <summary>
                        <span className={styles.queryName}>
                          {q.provider} · {q.operation}
                        </span>
                        <span className={q.status === 'ok' ? styles.ok : styles.warn}>{q.status}</span>
                        {q.is_replay ? <span className={styles.example}>Example result</span> : null}
                        {q.duration_ms !== null ? <span className={styles.small}>{q.duration_ms} ms</span> : null}
                      </summary>
                      <p className={styles.label}>Query input</p>
                      <Json value={q.request} />
                      <p className={styles.label}>Results</p>
                      <Json value={q.result_summary} />
                      <p className={styles.small}>
                        <span className={styles.mono}>{q.id}</span> · {time(q.retrieved_at)}
                      </p>
                    </details>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section id="recommendations" title="Recommendations" count={trace.recommendations.length}>
            {trace.recommendations.length === 0 ? (
              <Empty>No recommendations were published.</Empty>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Title</th>
                    <th scope="col">Provenance</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.recommendations.map((r) => (
                    <tr key={r.id}>
                      <td>{r.rank}</td>
                      <td>
                        {r.title}
                        {r.category ? <span className={styles.small}> · {r.category}</span> : null}
                      </td>
                      <td>
                        {ORIGIN_LABEL[r.origin] ?? r.origin}
                        {r.provider_query_ids.length > 0 ? (
                          <span className={styles.small}>
                            {' '}
                            · {r.provider_query_ids.length} quer{r.provider_query_ids.length === 1 ? 'y' : 'ies'}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section id="agent" title="Agent service calls" count={trace.agent_calls.length}>
            {trace.agent_calls.length === 0 ? (
              <Empty>No connected agent called the service for this job.</Empty>
            ) : (
              <ol className={styles.calls}>
                {trace.agent_calls.map((a, i) => (
                  <li key={i}>
                    <span className={styles.mono}>{a.tool}</span> <span className={styles.small}>· {a.client_name}</span>
                    <br />
                    <span className={styles.small}>
                      {time(a.at)} — {a.summary}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section id="events" title="Pipeline events" count={trace.events.length}>
            {trace.events.length === 0 ? (
              <Empty>No pipeline events were recorded.</Empty>
            ) : (
              <details>
                <summary className={styles.small}>Show {trace.events.length} events</summary>
                <ol className={styles.calls}>
                  {trace.events.map((e, i) => (
                    <li key={i}>
                      <span className={styles.tag}>{e.kind}</span> {e.name}
                      {e.duration_ms !== null ? <span className={styles.small}> · {e.duration_ms} ms</span> : null}
                      <Json value={e.data} />
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </Section>
        </div>
      </div>
    </main>
  );
}
