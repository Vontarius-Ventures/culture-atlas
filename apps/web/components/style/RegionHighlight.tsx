'use client';

import { useEffect, useState, type RefObject } from 'react';
import { regionQuadrant, regionToRect, type StyleRegion } from '@/lib/client/style';

export interface ActiveRegion {
  key: string;
  region: StyleRegion;
  label: string;
}

/**
 * Evidence region over the capture photo (F.1 §1): a 2 px ivory outline with a
 * 1 px olive inner line, everything else dimmed to 40% black over 180 ms.
 * Positioned from the rendered image box (object-fit: cover) so it tracks resizes.
 * Screen readers hear the quadrant ("highlighted area: upper left of the photo").
 */
export function RegionHighlight({
  imageRef,
  active,
  onClear,
}: {
  imageRef: RefObject<HTMLImageElement | null>;
  active: ActiveRegion | null;
  onClear: () => void;
}) {
  const [box, setBox] = useState<{
    width: number;
    height: number;
    nw: number;
    nh: number;
  } | null>(null);

  useEffect(() => {
    const img = imageRef.current;
    if (!img) return;
    const measure = () =>
      setBox({
        width: img.clientWidth,
        height: img.clientHeight,
        nw: img.naturalWidth,
        nh: img.naturalHeight,
      });
    measure();
    img.addEventListener('load', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(img);
    return () => {
      img.removeEventListener('load', measure);
      ro?.disconnect();
    };
  }, [imageRef]);

  const rect =
    active && box && box.width > 0
      ? regionToRect(
          active.region,
          { width: box.width, height: box.height },
          box.nw > 0 ? { width: box.nw, height: box.nh } : null,
        )
      : null;

  return (
    <>
      {active && rect && rect.width > 0 && rect.height > 0 && (
        <button
          type="button"
          className="region-highlight"
          aria-label="Clear highlight"
          onClick={onClear}
          key={active.key}
        >
          <span
            className="region-highlight__box"
            data-testid="region-highlight"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        </button>
      )}
      <span className="visually-hidden" aria-live="polite">
        {active ? `Highlighted area: ${regionQuadrant(active.region)}. ${active.label}` : ''}
      </span>
    </>
  );
}
