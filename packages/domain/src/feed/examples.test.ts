import { describe, expect, it } from 'vitest';
import { VlmAnalysis } from '@culture-atlas/providers';
import { EXAMPLE_IDS, examplePickItems, exampleReplay } from './examples';

describe('example replays', () => {
  it.each(EXAMPLE_IDS)('%s: valid reading, resemblance phrasing and every pick a reviewed sample tied to a reference', (id) => {
    const ex = exampleReplay(id)!;
    expect(VlmAnalysis.parse(ex.analysis)).toBeTruthy();
    expect(ex.analysis.quality.usable).toBe(true);
    const names = new Set(ex.analysis.candidates.map((c) => c.name));
    const picks = examplePickItems(ex);
    expect(picks).toHaveLength(ex.picks.length);
    for (const { pick, item } of picks) {
      expect(item.category).toBe(pick.category);
      expect(pick.references.length).toBeGreaterThan(0);
      for (const r of pick.references) expect(names.has(r)).toBe(true);
    }
    for (const c of ['wear', 'play', 'watch', 'eat']) expect(picks.filter((p) => p.pick.category === c).length).toBeLessThanOrEqual(3);
  });

  it('returns copies and nothing for unknown ids', () => {
    expect(exampleReplay('nope')).toBeNull();
    const a = exampleReplay('room')!;
    a.analysis.title = 'changed';
    expect(exampleReplay('room')!.analysis.title).toBe('A quiet, spare room');
  });
});
