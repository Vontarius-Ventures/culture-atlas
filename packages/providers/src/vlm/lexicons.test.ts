import { describe, expect, it } from 'vitest';
import {
  COLOURS,
  FASHION,
  FILM,
  FOOD,
  FOOD_EVIDENCE,
  FOOD_NAME_ENDINGS,
  GENERIC_NOUNS,
  GENERIC_QUALIFIERS,
  MAKERS,
  MATERIALS,
  MUSIC,
  STOP,
  foldText,
  hasPhrase,
  isNonLatin,
  nameTokens,
} from './lexicons';

const LISTS = { STOP, GENERIC_NOUNS, COLOURS, MATERIALS, GENERIC_QUALIFIERS, MAKERS, FASHION, MUSIC, FILM, FOOD, FOOD_EVIDENCE, FOOD_NAME_ENDINGS };

describe('lexicon tokenizer', () => {
  it('folds case and accents like normalizeName, and keeps CJK verbatim', () => {
    expect(nameTokens('Musée des Arts Décoratifs')).toEqual(['musee', 'des', 'arts', 'decoratifs']);
    expect(nameTokens('Théâtre du PALAIS-ROYAL')).toEqual(['theatre', 'du', 'palais', 'royal']);
    expect(nameTokens('港区 MINATO CITY')).toEqual(['港区', 'minato', 'city']);
    expect(nameTokens('Yuyuan Rd. 愚园路')).toEqual(['yuyuan', 'rd', '愚园路']);
    expect(foldText("Levi's & Co")).toBe('levis and co');
    expect(isNonLatin('愚园路')).toBe(true);
    expect(isNonLatin('cafe')).toBe(false);
    expect(hasPhrase('fixture dim sum house', 'dim sum')).toBe(true);
    expect(hasPhrase('fixture dimsum', 'dim sum')).toBe(false);
  });
});

describe('lexicon lists', () => {
  it('hold only folded, single tokens (so they match nameTokens output)', () => {
    for (const [name, list] of Object.entries(LISTS))
      for (const word of list) expect(nameTokens(word), `${name}: ${word}`).toEqual([word]);
  });

  it('never let a maker name be a generic word (a "car seat" is not a brand)', () => {
    for (const word of MAKERS) {
      expect(GENERIC_NOUNS.has(word), word).toBe(false);
      expect(GENERIC_QUALIFIERS.has(word), word).toBe(false);
      expect(COLOURS.has(word), word).toBe(false);
      expect(MATERIALS.has(word), word).toBe(false);
      expect(STOP.has(word), word).toBe(false);
    }
  });

  it('keep "cuisine", "food" and "fare" out of the food evidence: saying "cuisine" shows no food', () => {
    for (const word of ['cuisine', 'cuisines', 'food', 'foods', 'fare']) {
      expect(FOOD_NAME_ENDINGS.has(word), word).toBe(true);
      expect(FOOD_EVIDENCE.has(word), word).toBe(false);
    }
    // Every concrete food word that sets the food domain is also evidence of food.
    for (const word of FOOD) if (!FOOD_NAME_ENDINGS.has(word) && !['culinary', 'gastronomy'].includes(word)) expect(FOOD_EVIDENCE.has(word), word).toBe(true);
  });

  it('keep colour and furniture words out of the food domain', () => {
    for (const word of ['orange', 'lime', 'apple', 'coffee', 'tea', 'market', 'kitchen', 'bar']) expect(FOOD.has(word), word).toBe(false);
  });

  it('do not mark specific references as generic (recorded clean names stay references)', () => {
    const specific = ['mughal', 'neoclassicism', 'streetball', 'lustreware', 'jali', 'chhatri', 'wabi', 'denim', 'jazz', 'noir', 'izakaya'];
    for (const word of specific)
      expect(GENERIC_NOUNS.has(word) || GENERIC_QUALIFIERS.has(word) || COLOURS.has(word) || MATERIALS.has(word), word).toBe(false);
  });
});
