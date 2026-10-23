import { describe, expect, it } from 'vitest';
import { exclusionTerms, stripSafetyClaims, violatedExclusions } from './dietary';

describe('dietary exclusions', () => {
  it('matches stated exclusions and common forms', () => {
    expect(violatedExclusions({ title: 'Chicken satay skewers' }, ['peanuts'])).toEqual(['peanuts']);
    expect(violatedExclusions({ title: 'Cacio e pepe', ingredients: ['pecorino', 'pasta'] }, ['dairy', 'gluten'])).toEqual(['dairy', 'gluten']);
    expect(violatedExclusions({ title: 'Prawn toast' }, ['shellfish'])).toEqual(['shellfish']);
    expect(violatedExclusions({ title: 'Tomato salad', description: 'With basil and olive oil' }, ['peanuts', 'dairy'])).toEqual([]);
  });

  it('uses word boundaries (no false positives inside other words)', () => {
    expect(violatedExclusions({ title: 'Doughnut' }, ['nut'])).toEqual([]);
    expect(violatedExclusions({ title: 'Walnut cake' }, ['nuts'])).toEqual(['nuts']);
    expect(violatedExclusions({ title: 'Eggs in purgatory' }, ['egg'])).toEqual(['egg']);
  });

  it('expands vegetarian and vegan', () => {
    expect(violatedExclusions({ title: 'Bacon jam crostini' }, ['vegetarian'])).toEqual(['vegetarian']);
    expect(violatedExclusions({ title: 'Ricotta toast' }, ['vegan'])).toEqual(['vegan']);
    expect(exclusionTerms('Vegan')).toContain('honey');
  });

  it('never asserts that a dish is allergen-free', () => {
    expect(stripSafetyClaims('A bright salad. It is completely nut-free. Serve cold.')).toBe('A bright salad. Serve cold.');
    expect(stripSafetyClaims('Safe for allergies.')).toBe('');
    expect(stripSafetyClaims('A warm, smoky dish.')).toBe('A warm, smoky dish.');
  });
});

describe('stripExcludedMentions (plan prose never names an excluded ingredient)', () => {
  it('drops each sentence that names an exclusion, keeps the others', async () => {
    const { stripExcludedMentions } = await import('./dietary');
    const text = 'Grilled lemongrass chicken sets the mood. A green papaya salad, here without peanuts. Finish with mango.';
    expect(stripExcludedMentions(text, ['peanuts'])).toBe('Grilled lemongrass chicken sets the mood. Finish with mango.');
    expect(stripExcludedMentions('A creamy butter sauce.', ['dairy'])).toBe('');
    expect(stripExcludedMentions(text, [])).toBe(text);
  });
});
