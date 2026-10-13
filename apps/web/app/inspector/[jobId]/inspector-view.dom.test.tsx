import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceResponse } from '@culture-atlas/domain/schemas';
import { InspectorView } from './inspector-view';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const trace: TraceResponse = {
  job: { id: id(1), type: 'replace_plan_section', state: 'complete', created_at: '2026-10-13T10:00:00.000Z', finished_at: '2026-10-13T10:00:04.000Z' },
  capture: { id: id(2), image: { url: '/v1/media?k=signed', width: 800, height: 600, alt: 'The analyzed photo' } },
  plan: { id: id(3), version: 2, section: 'film', title: 'A warm night in', inputs: [{ item_id: id(4), title: 'Tampopo', kind: 'film' }] },
  related_origin: null,
  observations: [{ label: 'Linen shirt', kind: 'garment', certainty: 0.82 }],
  resolved_entities: [{ name: 'Tampopo', provider: 'qloo', provider_id: 'Q-FILM-1', type: 'film', reference_id: null }],
  provider_queries: [
    {
      id: id(5),
      provider: 'qloo',
      operation: 'insights',
      request: { filter_type: 'urn:entity:movie', signal_entities: ['Q-FILM-1'] },
      result_summary: { count: 8, top: [{ rank: 1, entity_id: 'Q-FILM-9', name: 'Film nine', affinity: 0.91 }] },
      status: 'ok',
      is_replay: false,
      retrieved_at: '2026-10-13T10:00:02.000Z',
      duration_ms: 240,
    },
    {
      id: id(6),
      provider: 'qloo',
      operation: 'insights',
      request: {},
      result_summary: null,
      status: 'ok',
      is_replay: true,
      retrieved_at: '2026-10-13T10:00:03.000Z',
      duration_ms: null,
    },
  ],
  references: [{ id: id(7), name: 'Kissaten coffee culture', claim_count: 3, source_count: 2 }],
  recommendations: [
    { id: id(8), title: 'Film nine · film', category: 'watch', origin: 'qloo', rank: 1, provider_query_ids: [id(5)] },
    { id: id(9), title: 'Creative Film One · alternate_film', category: 'watch', origin: 'vlm_creative', rank: 2, provider_query_ids: [] },
  ],
  taste_changes: [{ at: '2026-10-13T09:00:00.000Z', action: 'save', target_id: id(4) }],
  agent_calls: [
    { at: '2026-10-13T10:00:00.000Z', client_name: 'demo agent', tool: 'replace_plan_section', summary: `started job ${id(1)}` },
    { at: '2026-10-13T10:00:05.000Z', client_name: 'demo agent', tool: 'get_job', summary: 'job complete' },
  ],
  events: [{ at: '2026-10-13T10:00:01.000Z', kind: 'stage', name: 'compose', data: { section: 'film' }, duration_ms: 1200 }],
};

afterEach(cleanup);

describe('InspectorView', () => {
  it('shows the photo, ids, queries, provenance and the agent calls', () => {
    render(<InspectorView trace={trace} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Plan section replacement' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'The analyzed photo' }).getAttribute('src')).toBe('/v1/media?k=signed');
    expect(screen.getByText('Q-FILM-1')).toBeTruthy();
    expect(screen.getByText('Linen shirt')).toBeTruthy();
    expect(screen.getByText(/1 live of 2/)).toBeTruthy();

    const queries = screen.getByRole('region', { name: /Provider queries/ });
    expect(within(queries).getByText('Example result')).toBeTruthy();
    expect(within(queries).getByText(/Film nine/)).toBeTruthy();

    const recs = screen.getByRole('region', { name: /Recommendations/ });
    expect(within(recs).getByText('Qloo result')).toBeTruthy();
    expect(within(recs).getByText('Creative suggestion (not from Qloo)')).toBeTruthy();

    const agent = screen.getByRole('region', { name: /Agent service calls/ });
    expect(within(agent).getByText('replace_plan_section')).toBeTruthy();
    expect(within(agent).getAllByText(/demo agent/)).toHaveLength(2);
    expect(screen.getByText(/Kissaten coffee culture/)).toBeTruthy();
  });

  it('renders honest empty states', () => {
    render(
      <InspectorView
        trace={{
          ...trace,
          capture: null,
          plan: null,
          observations: [],
          resolved_entities: [],
          provider_queries: [],
          references: [],
          recommendations: [],
          taste_changes: [],
          agent_calls: [],
          events: [],
        }}
      />,
    );
    expect(screen.getByText('No provider queries were made.')).toBeTruthy();
    expect(screen.getByText('No connected agent called the service for this job.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
