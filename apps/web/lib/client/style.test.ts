import { readFileSync } from 'node:fs';
import { resolveFromWorkspace } from '@culture-atlas/providers';
import { describe, expect, it } from 'vitest';
import { CaptureResponse, STYLE_COPY as SERVER_COPY } from '@culture-atlas/domain/schemas';
import { styleMatchFor, MORE_LIKE_THIS_SEEDS, styleReading } from '../../e2e/mock/style';
import {
  analysisExperimental,
  claimText,
  detailRows,
  isActiveStatus,
  moodLine,
  needsCity,
  qlooLinksLine,
  Rail as RailSchema,
  railEmptyMessage,
  regionQuadrant,
  regionToRect,
  splitStyledCapture,
  STYLE_COPY,
  styleCardState,
  StyledCaptureResponse,
  StyledItemResponse,
  styleWorkPending,
  swatchSize,
  type Rail,
  type StyleExtras,
} from './style';

const NOW = '2026-10-23T12:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function card(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    kind: 'brand',
    category: 'wear',
    title: `Card ${n}`,
    subtitle: null,
    image: null,
    is_example: false,
    saved: false,
    saved_item_id: null,
    recommendation_id: id(n + 1000),
    evidence_available: true,
    ...extra,
  };
}

function capture(over: Record<string, unknown> = {}, analysisOver: Record<string, unknown> = {}) {
  return {
    id: id(1),
    source: 'upload',
    status: 'ready',
    received_at: NOW,
    captured_at: null,
    image: { url: '/samples/outfit.jpg', width: 1000, height: 1250, alt: 'photo' },
    focus: { kind: 'whole' },
    is_example: false,
    discovery_item_id: id(2),
    saved: false,
    analysis: {
      id: id(3),
      version: 1,
      title: 'Jacket',
      interpretation: null,
      sections: { observations: 'complete', wear: 'complete' },
      question: null,
      warnings: [],
      created_at: NOW,
      ...analysisOver,
    },
    references: [],
    recommendations: [card(10)],
    available_categories: ['wear'],
    job_id: null,
    ...over,
  };
}

describe('StyledCaptureResponse (E.2 additive fields)', () => {
  it('preserves server titles and the full public reason length, including legacy rail labels', () => {
    const reason = 'A catalogue connection to explore. '.repeat(5);
    for (const title of [
      'Brands to explore',
      'Films to explore',
      'Qloo connections',
      'More like this',
    ]) {
      const parsed = RailSchema.parse({
        key: 'more_like_this:s1',
        kind: 'more_like_this',
        title,
        subtitle: 'Reading context',
        status: 'ready',
        empty_message: null,
        cards: [card(20, { reason })],
      });
      expect(parsed.title).toBe(title);
      expect(parsed.cards[0]!.reason).toBe(reason.trim());
    }
  });

  it('an older analysis parses exactly as the base contract, with no style', () => {
    const raw = capture();
    const parsed = StyledCaptureResponse.parse(raw);
    expect(parsed.style).toEqual({
      status: null,
      reading: null,
      rails: null,
      experimental: null,
      waitingReason: null,
    });
    expect(CaptureResponse.parse(raw).recommendations).toHaveLength(1);
    expect(styleCardState(parsed.style)).toEqual({ kind: 'none' });
  });

  it('lifts sections.style, style_reading, rails and the experimental label', () => {
    const raw = capture(
      {
        style_reading: styleReading(),
        rails: [
          {
            key: 'more_like_this:s1',
            kind: 'more_like_this',
            title: 'More like this',
            subtitle: 'Sportswear · nylon shell',
            subject_id: 's1',
            status: 'ready',
            empty_message: null,
            cards: [
              card(20, {
                reason: 'Because of the sportswear',
                style_match: styleMatchFor(MORE_LIKE_THIS_SEEDS[0]!),
              }),
            ],
          },
        ],
      },
      {
        sections: { observations: 'complete', style: 'ready', wear: 'ready', eat: 'empty' },
        experimental: {
          label: 'Experimental',
          note: 'Photo and video readings can miss details. Qloo explores entity-level taste and catalogue connections, not verified visual matches.',
        },
      },
    );
    const parsed = StyledCaptureResponse.parse(raw);
    expect(parsed.style.status).toBe('ready');
    expect(parsed.style.reading?.subjects).toHaveLength(2);
    expect(parsed.style.reading?.subjects[0]!.aesthetics.map((a) => a.display)).toEqual([
      'Sportswear',
      'Resembles vintage motorsport',
    ]);
    expect(parsed.style.reading?.subjects[0]!.era?.display).toBe('Suggests the 1970s');
    expect(parsed.style.rails?.[0]!.cards[0]!.reason).toBe('Because of the sportswear');
    expect(parsed.style.rails?.[0]!.cards[0]!.style_match?.attributes).toEqual([
      'Sportswear',
      'nylon shell',
    ]);
    expect(parsed.style.experimental?.label).toBe('Experimental');
    // The shared contract carries the E.2 statuses now, so they pass through unchanged
    // (`style` itself is lifted into `parsed.style.status`).
    expect(parsed.analysis?.sections).toEqual({
      observations: 'complete',
      wear: 'ready',
      eat: 'empty',
    });
    expect(parsed.style.status).toBe('ready');
  });

  it('a malformed claim is dropped alone; a malformed reading never breaks the page', () => {
    const reading = styleReading();
    (reading.subjects[0]!.aesthetics as unknown[]).push({ name: 42 });
    (reading.subjects[0]!.palette as unknown[]).push({
      swatch: 0,
      name: 'x',
      hex: 'red;background:url(x)',
    });
    const parsed = StyledCaptureResponse.parse(
      capture({ style_reading: reading }, { sections: { style: 'ready' } }),
    );
    expect(parsed.style.reading?.subjects[0]!.aesthetics).toHaveLength(2);
    expect(parsed.style.reading?.subjects[0]!.palette.map((p) => p.hex)).toEqual([
      '#E9E1CF',
      '#B23A2E',
    ]);
    const broken = StyledCaptureResponse.parse(
      capture({ style_reading: 'nonsense', rails: 'nope' }, { sections: { style: 'ready' } }),
    );
    expect(broken.style.reading).toBeNull();
    expect(broken.style.rails).toBeNull();
    expect(styleCardState(broken.style)).toEqual({ kind: 'empty' });
  });

  it('a reading is not shown before the section is ready', () => {
    const { extras } = splitStyledCapture(
      capture({ style_reading: styleReading() }, { sections: { style: 'running' } }),
    );
    expect(extras.reading).toBeNull();
    expect(styleCardState(extras)).toEqual({ kind: 'loading' });
  });

  it('base contract errors still fail loudly', () => {
    expect(StyledCaptureResponse.safeParse(capture({ id: 'nope' })).success).toBe(false);
  });
});

describe('wording is never composed on the client (A.2 / R-16b)', () => {
  it('uses the server display string', () => {
    expect(claimText({ name: 'linen', wording: 'resembles', display: 'Looks like linen' })).toBe(
      'Looks like linen',
    );
  });
  it('shows an asserted claim by name when display is missing', () => {
    expect(claimText({ name: 'Workwear', wording: 'asserted' })).toBe('Workwear');
  });
  it('hides an unasserted claim without display, and held claims', () => {
    expect(claimText({ name: 'Japandi', wording: 'resembles' })).toBeNull();
    expect(
      claimText({ name: 'Workwear', wording: 'asserted', display: 'Workwear', held: true }),
    ).toBeNull();
  });
  it('mood line joins server strings and never shows mood without display', () => {
    expect(moodLine([{ display: 'Feels rugged' }, { display: 'Feels utilitarian' }])).toBe(
      'Feels rugged, utilitarian',
    );
    expect(moodLine([{ display: null }])).toBeNull();
    expect(moodLine([{ display: 'Feels warm', retracted: true }])).toBeNull();
  });
});

describe('detail rows', () => {
  it('orders Era & lineage, Materials, Construction, Details and marks resemblances', () => {
    const parsed = StyledCaptureResponse.parse(
      capture({ style_reading: styleReading() }, { sections: { style: 'ready' } }),
    );
    const rows = detailRows(parsed.style.reading!, 0);
    expect(rows.map((r) => r.group)).toEqual([
      'Era & lineage',
      'Era & lineage',
      'Materials',
      'Materials',
      'Construction',
      'Details',
    ]);
    expect(rows[0]).toMatchObject({ text: 'Suggests the 1970s', resembles: true });
    expect(rows[2]).toMatchObject({ text: 'Nylon shell', resembles: false });
    expect(rows[2]!.region).not.toBeNull();
  });

  it('flags retracted claims from the claim flag or the retracted[] paths', () => {
    const parsed = StyledCaptureResponse.parse(
      capture(
        { style_reading: { ...styleReading(), retracted: ['subjects[0].materials[1]'] } },
        { sections: { style: 'ready' } },
      ),
    );
    const rows = detailRows(parsed.style.reading!, 0);
    expect(rows.find((r) => r.text === 'Looks like ribbed knit cuffs')?.retracted).toBe(true);
    expect(rows.find((r) => r.text === 'Nylon shell')?.retracted).toBe(false);
  });
});

describe('states and polling', () => {
  const extras = (o: Partial<StyleExtras>): StyleExtras => ({
    status: null,
    reading: null,
    rails: null,
    experimental: null,
    waitingReason: null,
    ...o,
  });
  const rail = (status: string, cards = 0): Rail =>
    ({
      key: 'k',
      kind: 'more_like_this',
      title: 'More like this',
      subtitle: null,
      subject_id: 's1',
      status,
      empty_message: null,
      cards: Array.from({ length: cards }, (_, i) => card(i)),
    }) as unknown as Rail;

  it('terminal statuses are ready, empty, failed, held and anything unknown (R-16c)', () => {
    for (const s of ['ready', 'empty', 'failed', 'held', 'mystery'])
      expect(isActiveStatus(s)).toBe(false);
    for (const s of ['pending', 'running']) expect(isActiveStatus(s)).toBe(true);
  });

  it('keeps polling while the reading or any rail is pending or running', () => {
    expect(styleWorkPending(extras({ status: 'running' }))).toBe(true);
    expect(styleWorkPending(extras({ status: 'ready', rails: [rail('running')] }))).toBe(true);
    expect(styleWorkPending(extras({ status: 'ready', rails: [rail('ready', 2)] }))).toBe(false);
    expect(styleWorkPending(extras({}))).toBe(false);
  });

  it('maps D.2 situations to card states', () => {
    expect(styleCardState(extras({ status: 'failed' })).kind).toBe('failed');
    expect(styleCardState(extras({ status: 'empty' })).kind).toBe('empty');
    expect(styleCardState(extras({ status: 'held', waitingReason: 'daily_limit' })).kind).toBe(
      'limit',
    );
    expect(styleCardState(extras({ status: 'held', waitingReason: 'ai_paused' })).kind).toBe(
      'paused',
    );
    expect(styleCardState(extras({ status: 'pending' })).kind).toBe('loading');
  });

  it('rail empty messages are honest and never invent cards', () => {
    expect(railEmptyMessage(rail('running'))).toBeNull();
    expect(railEmptyMessage(rail('ready', 3))).toBeNull();
    expect(railEmptyMessage(rail('empty'))).toBe(STYLE_COPY['style.rail_empty']);
    expect(railEmptyMessage({ ...rail('empty'), empty_message: STYLE_COPY['style.no_city'] })).toBe(
      STYLE_COPY['style.no_city'],
    );
    expect(needsCity('Add a city to explore places.')).toBe(true);
    expect(needsCity(STYLE_COPY['style.rail_empty'])).toBe(false);
  });
});

describe('copy (D.4, verbatim)', () => {
  it('every shared key matches the complete design and server copy', () => {
    const design = JSON.parse(readFileSync(resolveFromWorkspace('design/copy.json'), 'utf8'));
    expect(SERVER_COPY).toEqual(design);
    for (const [group, entries] of Object.entries(SERVER_COPY)) {
      for (const [key, value] of Object.entries(entries)) {
        expect(STYLE_COPY[`${group}.${key}` as keyof typeof STYLE_COPY]).toBe(value);
      }
    }
  });

  it('matches the design table', () => {
    expect(STYLE_COPY['experimental.badge']).toBe('Experimental');
    expect(STYLE_COPY['experimental.note']).toBe(
      'Photo and video readings can miss details. Qloo explores entity-level taste and catalogue connections, not verified visual matches.',
    );
    expect(STYLE_COPY['experimental.why_line']).toBe(
      'Suggested from an experimental reading of your photo.',
    );
    expect(STYLE_COPY['style.limit']).toBe(
      "We've hit today's limit for experimental readings. Your photo is saved, and you can read it tomorrow.",
    );
    expect(qlooLinksLine(['Filson', 'Patagonia', 'Pendleton'])).toBe(
      'Qloo also links: Filson, Patagonia, Pendleton',
    );
    expect(qlooLinksLine([])).toBeNull();
  });

  it('labels any experimental analysis, whatever the server label says', () => {
    expect(
      analysisExperimental({ available: true, experimental: true, label: 'Experimental reading' }),
    ).toEqual({
      label: 'Experimental',
      note: STYLE_COPY['experimental.note'],
    });
    expect(analysisExperimental({ available: true })).toBeNull();
    expect(analysisExperimental(undefined)).toBeNull();
  });
});

describe('geometry', () => {
  it('maps a region onto a cover-fitted image and clips it', () => {
    // A square image covering a 500x250 box: scale 0.5, 125 px cropped top and bottom.
    const rect = regionToRect(
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { width: 500, height: 250 },
      { width: 1000, height: 1000 },
    );
    expect(rect).toEqual({ left: 0, top: 0, width: 250, height: 125 });
    const full = regionToRect(
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { width: 400, height: 500 },
      null,
    );
    expect(full.left).toBeCloseTo(40);
    expect(full.top).toBeCloseTo(50);
    expect(full.width).toBeCloseTo(80);
    expect(full.height).toBeCloseTo(100);
  });

  it('describes quadrants for screen readers', () => {
    expect(regionQuadrant({ x: 0, y: 0, w: 0.2, h: 0.2 })).toBe('upper left of the photo');
    expect(regionQuadrant({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe('center of the photo');
    expect(regionQuadrant({ x: 0.8, y: 0.45, w: 0.1, h: 0.1 })).toBe('middle right of the photo');
  });

  it('sizes swatches 28–56 px by share', () => {
    expect(swatchSize(undefined)).toBe(28);
    expect(swatchSize(0)).toBe(28);
    expect(swatchSize(0.25)).toBe(42);
    expect(swatchSize(1)).toBe(56);
  });
});

describe('StyledItemResponse ("Why this?")', () => {
  it('reads style_match and experimental_line from the top level or why_this', async () => {
    const base = {
      item: card(30),
      description: null,
      detail: null,
      reason: null,
      why_this: { text: 'Because.', sources: [] },
      destination_url: null,
      references: [],
      related: [],
      related_state: 'cached',
      related_job_id: null,
      collection_ids: [],
      capture_id: null,
    };
    const top = StyledItemResponse.safeParse({
      ...base,
      style_match: styleMatchFor({ attributes: ['Workwear'] }),
      experimental_line: STYLE_COPY['experimental.why_line'],
    });
    expect(top.success, JSON.stringify(top.error?.issues)).toBe(true);
    expect(top.data?.style_match?.attributes).toEqual(['Workwear']);
    expect(top.data?.experimental_line).toBe(STYLE_COPY['experimental.why_line']);
    const plain = StyledItemResponse.parse(base);
    expect(plain.style_match).toBeNull();
    expect(plain.experimental_line).toBeNull();
  });
});
