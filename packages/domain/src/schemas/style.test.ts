import { readFileSync } from 'node:fs';
import { resolveFromWorkspace } from '@culture-atlas/providers';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { CaptureResponse } from './captures';
import { RailDto, STYLE_COPY, StyleReadingDto } from './style';

const messages = (JSON.parse(readFileSync(resolveFromWorkspace('fixtures/native-contract/messages.json'), 'utf8')) as { messages: Record<string, { body: unknown }> }).messages;

describe('style wire contract (style design §E.2, R-16)', () => {
  it('every capture_style example parses, and its style_reading and rails parse on their own', () => {
    const names = Object.keys(messages).filter((k) => k.startsWith('capture_style'));
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      const body = messages[name]!.body as { style_reading: unknown; rails: unknown[] };
      expect(CaptureResponse.safeParse(body).success, name).toBe(true);
      if (body.style_reading) expect(StyleReadingDto.safeParse(body.style_reading).success, name).toBe(true);
      for (const r of body.rails) expect(RailDto.safeParse(r).success, name).toBe(true);
    }
  });

  it('old clients: a capture without rails or style fields still parses, and the old schema ignores the new fields', () => {
    const body = structuredClone(messages.capture_style_response!.body) as Record<string, unknown>;
    const withoutNew = { ...body };
    delete withoutNew.rails;
    delete withoutNew.style_reading;
    expect(CaptureResponse.safeParse(withoutNew).success).toBe(true);
    // A client built on the pre-style schema (no rails/style_reading keys) still decodes the new body.
    const Old = CaptureResponse.omit({ rails: true, style_reading: true });
    expect(Old.safeParse(body).success).toBe(true);
  });

  it('never sends certainty, and strength follows wording (R-16a)', () => {
    const body = messages.capture_style_response!.body as { style_reading: z.infer<typeof StyleReadingDto> };
    expect(JSON.stringify(body)).not.toContain('certainty');
    for (const a of body.style_reading.subjects.flatMap((s) => s.aesthetics))
      expect(a.wording === 'asserted' ? ['clear', 'likely'] : ['likely', 'possible']).toContain(a.strength);
  });

  it('keeps the D.4 copy verbatim', () => {
    expect(STYLE_COPY.experimental).toEqual({
      badge: 'Experimental',
      note: 'Photo and video readings are experimental. They can miss or misread details.',
      rail_caption: 'From an experimental reading',
      why_line: 'Suggested from an experimental reading of your photo.',
    });
    expect(STYLE_COPY.style.no_city).toBe('Add a city to see places with this style.');
    expect(STYLE_COPY.style.rail_empty).toBe('Qloo found nothing close to this style yet.');
  });
});
