'use client';

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { cropForKey, moveCrop, resizeCrop, type CropBox } from '@/lib/client/crop';

/**
 * Optional crop frame over the preview. Drag to move, drag the corner to
 * resize; keyboard: arrows move, Shift+arrows resize.
 */
export function CropFrame({ box, onChange }: { box: CropBox; onChange: (b: CropBox) => void }) {
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; start: CropBox } | null>(
    null,
  );

  const begin = (mode: 'move' | 'resize', e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: box };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    const rect = area.current?.getBoundingClientRect();
    if (!d || !rect || rect.width === 0 || rect.height === 0) return;
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    onChange(d.mode === 'move' ? moveCrop(d.start, dx, dy) : resizeCrop(d.start, dx, dy));
  };
  const end = () => {
    drag.current = null;
  };

  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  return (
    <div className="crop" ref={area} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}>
      <div
        className="crop__frame"
        style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
        role="group"
        tabIndex={0}
        aria-label="Crop area. Use arrow keys to move it and Shift with arrow keys to resize it."
        onPointerDown={(e) => begin('move', e)}
        onKeyDown={(e) => {
          const next = cropForKey(box, e.key, e.shiftKey);
          if (next) {
            e.preventDefault();
            onChange(next);
          }
        }}
      >
        <span
          className="crop__handle"
          onPointerDown={(e) => begin('resize', e)}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
