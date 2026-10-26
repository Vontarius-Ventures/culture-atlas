import { describe, expect, it } from 'vitest';
import { fashionProductEligible, productFormGate, productFormOf, productFormsIn } from './product-evidence';
import { storedAesthetic, storedSubject } from './test-support';

describe('product forms are independent of broad provider families', () => {
  it('distinguishes bag forms and common spelling variants in noun order', () => {
    expect(productFormsIn('Wallet, clutch, duffle, backpack, cross-body bag')).toEqual(['wallet', 'clutch', 'duffel', 'backpack', 'crossbody']);
    expect(productFormOf(storedSubject({ label: 'Backpack with crossbody strap' }))).toBe('backpack');
    expect(productFormGate('crossbody', ['backpack'])).toBe('incompatible_form');
    expect(productFormGate('crossbody', [])).toBe('unsupported_form');
    expect(productFormGate('crossbody', ['backpack', 'crossbody'])).toBeNull();
    expect(productFormGate(null, ['backpack'])).toBeNull();
  });

  it('uses only active construction to specialize a generic product label', () => {
    const construction = [
      { ...storedAesthetic('Backpack', { held: true }), kind: 'sewn' },
      { ...storedAesthetic('Wallet', { retracted: true }), kind: 'sewn' },
      { ...storedAesthetic('Crossbody strap'), kind: 'sewn' },
    ];
    expect(productFormOf(storedSubject({ label: 'Leather bag', construction }))).toBe('crossbody');
    expect(productFormOf(storedSubject({ label: 'Leather bag', construction: construction.slice(0, 2) }))).toBeNull();
  });

  it('requires a recognized fashion product, not fashion-like styling of equipment', () => {
    for (const label of ['Tennis racket', 'Tennis racquet with bag', 'Golf club', 'Yoga mat', 'Unidentified object']) {
      expect(fashionProductEligible(storedSubject({ label })), label).toBe(false);
    }
    for (const label of ['Tennis skirt', 'Wool coat', 'Cotton dress', 'Silk blouse', 'Linen trousers', 'Saree', 'Trench coat', 'Knit pullover', 'Leather cross-body bag']) {
      expect(fashionProductEligible(storedSubject({ label })), label).toBe(true);
    }
  });
});
