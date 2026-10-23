import Link from 'next/link';
import type { Image } from '@culture-atlas/domain/schemas';
import { pluralItems } from '@/lib/client/format';
import { Icon } from './Icon';

/**
 * Bounded mosaic of one to three images with a shared rounded outside edge and
 * narrow internal gaps. 3 images: one tall tile left, two stacked right.
 */
export function CoverMosaic({
  images,
  size = 'large',
}: {
  images: readonly Image[];
  size?: 'large' | 'mini';
}) {
  // Large covers follow mockup 07: three or more images make one tall tile and
  // two stacked tiles; fewer show the first image alone.
  const tiles = size === 'mini' ? images.slice(0, 3) : images.slice(0, images.length >= 3 ? 3 : 1);
  return (
    <div
      className={`mosaic mosaic--${size} mosaic--n${Math.max(tiles.length, 0)}`}
      aria-hidden="true"
    >
      {tiles.length === 0 ? (
        <div className="mosaic__empty">
          <Icon name="collection" size={size === 'mini' ? 20 : 32} />
        </div>
      ) : (
        tiles.map((img, i) => (
          <img
            key={`${img.url}-${i}`}
            src={img.url}
            alt=""
            loading="lazy"
            decoding="async"
            className="mosaic__tile"
          />
        ))
      )}
    </div>
  );
}

/** CollectionCover: mosaic, name with a private lock, and the private item count. */
export function CollectionCover({
  href,
  name,
  count,
  images,
  privateLabel = true,
}: {
  href: string;
  name: string;
  count: number;
  images: readonly Image[];
  privateLabel?: boolean;
}) {
  return (
    <article className="cover">
      <CoverMosaic images={images} />
      <h2 className="cover__name">
        <Link href={href} className="cover__link">
          {name}
        </Link>
        {privateLabel && <Icon name="lock" size={16} className="cover__lock" label="Private" />}
      </h2>
      <p className="cover__count">{pluralItems(count)}</p>
    </article>
  );
}
