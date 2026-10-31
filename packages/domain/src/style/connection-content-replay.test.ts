import { describe, expect, it } from 'vitest';
import { parseConnectionContentFocus } from './content-evidence';

// Bounded exact retained candidate-owned excerpts from the v9 failure packet.
// These replay mechanisms, not new usefulness ratings, quality gates or a holdout.
const replay = [
  ['Poor Little Rich Girl', 'coffee', 'incidental', 'The film follows a young, jobless woman as she lounges in bed, smokes, talks on the phone, makes coffee and tries on clothes from a large wardrobe, alternating between out-of-focus and clear footage.'],
  ['In No Great Hurry', 'coffee', 'incidental', 'The film follows Leiter in his New York apartment as he photographs, drinks coffee, and confronts clearing an archive while negotiating newfound attention in his eighties.'],
  ['Match Point', 'tennis', 'incidental', 'The film follows a former tennis professional who marries into an affluent London family while carrying on a perilous affair with a struggling actress; the ensuing pregnancy and choices force a desperate, consequential act.'],
  ['Black Harvest', 'coffee', 'central', 'Black Harvest (1992), directed by Robin Anderson and Bob Connolly, is an Australian documentary that follows Joe Leahy and the Ganiga people of the Papua New Guinea highlands as they build and struggle over coffee plantations.'],
  ['King Richard', 'tennis', 'central', 'King Richard (2021), directed by Reinaldo Marcus Green and starring Will Smith, Aunjanue Ellis, Saniyya Sidney and Demi Singleton, is a biographical sports drama about the upbringing and rise of two future tennis champions under the guidance of their father.'],
  ['Federer: Twelve Final Days', 'tennis', 'central', 'Federer: Twelve Final Days (2024), directed by Asif Kapadia and Joe Sabia, is a biographical sports documentary that follows the last twelve days of a celebrated tennis career.'],
  ['Uffizi', 'sculpture', 'central', 'The film employs 3D and 4K imaging plus digital modelling to examine paintings, sculpture and architecture of the Florentine Renaissance, pairing expert commentary with extreme close-ups and aerial sequences.'],
] as const;

describe('bounded recorded content replay (not usefulness evaluation)', () => {
  it.each(replay)('%s: exact role, field and original offsets', (_title, topic, focus, description) => {
    const result = parseConnectionContentFocus(topic, { description });
    expect(result.focus).toBe(focus);
    expect(result.field).toBe('description');
    expect(result.excerpt).toBe(description);
    expect(result.range).toEqual({ start: 0, end: description.length });
  });
  it('uses whole context rather than laundering an incidental plot through a short synopsis', () => {
    expect(parseConnectionContentFocus('tennis', {
      description: replay[2][3], short_description: replay[4][3],
    }).focus).toBe('incidental');
  });
  it('does not fabricate a missing Tim’s Vermeer synopsis', () => {
    expect(parseConnectionContentFocus('painting', { title: 'Tim’s Vermeer' })).toEqual({ focus: 'unknown' });
  });
  it('cannot conceal oversized unexamined context behind a focused short description', () => {
    expect(parseConnectionContentFocus('tennis', {
      description: 'x'.repeat(20_001), short_description: replay[4][3],
    })).toEqual({ focus: 'unknown' });
  });
  it('retains whitespace-relative offsets and distinguishes supporting from unknown', () => {
    const description = '  A sculpture in the collection.  ';
    expect(parseConnectionContentFocus('sculpture', { description })).toEqual({
      focus: 'supporting', field: 'description', excerpt: description.trim(),
      range: { start: 2, end: description.length - 2 },
    });
    expect(parseConnectionContentFocus('coffee', { description }).focus).toBe('unknown');
  });
});
