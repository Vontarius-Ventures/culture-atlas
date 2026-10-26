'use client';

import type { CSSProperties } from 'react';
import { swatchSize } from '@/lib/client/style';

export interface SwatchView {
  key: string;
  hex: string;
  text: string;
  share?: number;
}

/**
 * Measured colors (A.4): circles sized by share (28–56 px) with the name below.
 * The hex is never printed; selecting a swatch copies its name.
 */
export function PaletteSwatches({
  swatches,
  onCopied,
}: {
  swatches: SwatchView[];
  onCopied?: (name: string) => void;
}) {
  if (swatches.length === 0) return null;
  const copy = async (name: string) => {
    try {
      await navigator.clipboard?.writeText(name);
    } catch {
      // Clipboard can be blocked; the announcement still names the color.
    }
    onCopied?.(name);
  };
  return (
    <ul className="style-palette" aria-label="Palette">
      {swatches.map((s, i) => {
        const size = swatchSize(s.share);
        return (
          <li
            key={s.key}
            className="style-palette__item style-enter"
            style={{ '--i': Math.min(i + 3, 7) } as CSSProperties}
          >
            <button
              type="button"
              className="style-palette__button"
              aria-label={`${s.text}. Copy color name`}
              onClick={() => void copy(s.text)}
            >
              <span
                className="style-palette__dot"
                aria-hidden="true"
                style={{ width: size, height: 28, backgroundColor: s.hex }}
              />
              <span className="style-palette__name">{s.text}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Static placeholder circles for the loading state (no shimmer, per the design guide). */
export function PaletteSkeleton({ count = 5 }: { count?: number }) {
  return (
    <ul className="style-palette" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="style-palette__item">
          <span className="style-palette__dot style-palette__dot--skeleton" />
        </li>
      ))}
    </ul>
  );
}
