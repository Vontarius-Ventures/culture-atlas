import { describe, expect, it } from 'vitest';
import { foldPreferences, WEIGHTS, type FoldSave } from './taste-fold';

const save = (over: Partial<FoldSave> & Pick<FoldSave, 'item_id'>): FoldSave => ({
  saved_item_id: `s-${over.item_id}`,
  kind: 'film',
  category: 'watch',
  title: over.item_id,
  canonical_key: `k:${over.item_id}`,
  reference_id: null,
  anchors: [],
  ...over,
});

describe('preference folding', () => {
  it('an individual save endorses only that item; its anchors get a smaller weight', () => {
    const s = foldPreferences([save({ item_id: 'film1', anchors: [{ reference_id: 'r1', name: 'New Wave', user_selected: false }] })]);
    expect(s.interests.find((i) => i.item_id === 'film1')).toMatchObject({ strength: 'strong', weight: WEIGHTS.item });
    expect(s.interests.find((i) => i.reference_id === 'r1')).toMatchObject({ strength: 'some', weight: WEIGHTS.itemAnchor });
    expect(s.saved_count).toBe(1);
    expect(s.categories).toEqual({ watch: 1 });
  });

  it('an inspiration save contributes its anchors (user-selected count fully), not the photo itself', () => {
    const s = foldPreferences([
      save({
        item_id: 'cap1',
        kind: 'capture',
        category: null,
        anchors: [
          { reference_id: 'r1', name: 'Mod tailoring', user_selected: true },
          { reference_id: 'r2', name: 'Breton stripe', user_selected: false },
        ],
      }),
    ]);
    expect(s.interests.some((i) => i.item_id === 'cap1')).toBe(false);
    expect(s.anchors).toEqual([
      { reference_id: 'r1', name: 'Mod tailoring', weight: WEIGHTS.selectedAnchor },
      { reference_id: 'r2', name: 'Breton stripe', weight: WEIGHTS.captureAnchor },
    ]);
  });

  it('saving into more collections never multiplies weight (input is unique saved items)', () => {
    const one = save({ item_id: 'a', anchors: [{ reference_id: 'r', name: 'R', user_selected: false }] });
    const single = foldPreferences([one]);
    const duplicated = foldPreferences([one, { ...one, saved_item_id: 'dup' }, one]);
    expect(duplicated).toEqual(single);
  });

  it('accumulates shared anchors across distinct saves with a cap', () => {
    const anchors = [{ reference_id: 'r', name: 'R', user_selected: true }];
    const s = foldPreferences(['a', 'b', 'c', 'd', 'e'].map((id) => save({ item_id: id, anchors })));
    expect(s.anchors[0]!.weight).toBe(WEIGHTS.anchorCap);
    expect(s.interests.find((i) => i.reference_id === 'r')!.strength).toBe('strong');
  });

  it('hide excludes that item only, never its category or culture', () => {
    const anchors = [{ reference_id: 'r', name: 'Bossa nova', user_selected: false }];
    const s = foldPreferences(
      [save({ item_id: 'a', kind: 'artist', category: 'play', anchors }), save({ item_id: 'b', kind: 'artist', category: 'play', anchors })],
      new Set(['k:a']),
    );
    expect(s.interests.map((i) => i.item_id)).toContain('b');
    expect(s.interests.map((i) => i.item_id)).not.toContain('a');
    expect(s.categories).toEqual({ play: 1 });
    expect(s.anchors[0]!.reference_id).toBe('r');
  });

  it('unsave is reflected immediately: folding is a pure function of current saves', () => {
    const a = save({ item_id: 'a' });
    const b = save({ item_id: 'b' });
    expect(foldPreferences([a, b]).saved_count).toBe(2);
    expect(foldPreferences([a]).interests.map((i) => i.item_id)).toEqual(['a']);
    expect(foldPreferences([]).interests).toEqual([]);
  });
});
