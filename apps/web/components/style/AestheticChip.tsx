'use client';

import type { CSSProperties } from 'react';
import { MoreMenu } from '../ui';
import { STYLE_COPY, strengthLabel, type AestheticClaim } from '@/lib/client/style';

/**
 * One aesthetic as a pill (F.1 §2). Asserted: solid olive border and the name.
 * Resembles: dashed border and the server's `display` text ("Resembles …").
 * Strength is never drawn (R-17); it is only in the accessible name.
 * Selecting a chip with a region highlights it on the photo; the menu offers
 * "Show more like this style" when the subject has a rail.
 */
export function AestheticChip({
  claim,
  text,
  index,
  active,
  retracted,
  onSelect,
  onMoreLikeThis,
}: {
  claim: AestheticClaim;
  text: string;
  index: number;
  active: boolean;
  retracted: boolean;
  onSelect?: () => void;
  onMoreLikeThis?: () => void;
}) {
  const strength = strengthLabel(claim.strength);
  const asserted = claim.wording === 'asserted';
  const style = { '--i': Math.min(index, 7) } as CSSProperties;
  const label = strength ? `${text}, ${strength}` : text;
  return (
    <li
      className={`style-chip style-chip--${asserted ? 'asserted' : 'resembles'} style-enter${
        retracted ? ' is-retracted' : ''
      }${active ? ' is-active' : ''}`}
      style={style}
      data-wording={claim.wording}
    >
      {onSelect && claim.region ? (
        <button
          type="button"
          className="style-chip__label"
          aria-pressed={active}
          aria-label={label}
          onClick={onSelect}
        >
          {text}
        </button>
      ) : (
        <span className="style-chip__label">
          {text}
          {strength && <span className="visually-hidden">, {strength}</span>}
        </span>
      )}
      {onMoreLikeThis && !retracted && (
        <span className="style-chip__menu">
          <MoreMenu
            label={`More for ${text}`}
            align="start"
            items={[{ label: STYLE_COPY['style.more_like_this_style'], onSelect: onMoreLikeThis }]}
          />
        </span>
      )}
    </li>
  );
}
