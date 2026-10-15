import type { Category, CollectionFilter, ItemKind, Scope } from '@culture-atlas/domain';

export const CATEGORY_LABELS: Record<Category, string> = {
  wear: 'Wear',
  play: 'Play',
  watch: 'Watch',
  eat: 'Eat',
};
export const CATEGORY_ORDER: readonly Category[] = ['wear', 'play', 'watch', 'eat'];

export const COLLECTION_FILTER_LABELS: Record<CollectionFilter, string> = {
  photos: 'Photos',
  music: 'Music',
  films: 'Films',
  food: 'Food',
  style: 'Style',
};
export const COLLECTION_FILTER_ORDER: readonly CollectionFilter[] = [
  'photos',
  'music',
  'films',
  'food',
  'style',
];

/** Plain-language kind names (used in text treatments and screen-reader labels, never as badges). */
export const KIND_LABELS: Record<ItemKind, string> = {
  capture: 'Photo',
  style: 'Style',
  brand: 'Brand',
  artist: 'Artist',
  track: 'Track',
  film: 'Film',
  food: 'Food idea',
  reference: 'Reference',
};

export const SCOPE_LABELS: Record<Scope, string> = {
  'captures:read': 'See your photos’ discoveries',
  'captures:write': 'Add photos for discovery',
  'collections:read': 'See collections you choose',
  'collections:write': 'Add to and organize those collections',
  'taste:read': 'See what you have saved',
  'taste:write': 'Save or hide items for you',
  'plans:read': 'See your plans',
  'plans:write': 'Create and change plans',
  'setup:read': 'View my device setup',
  'preferences:read': 'Read my preferences',
  'preferences:write': 'Change ordinary preferences',
  'media:read': 'View permitted photos and videos',
  'media:download': 'Download permitted originals',
  'media:write': 'Upload media and manage agent-created drafts',
  'media:analyze': 'Request analysis of permitted media',
  'devices:command': 'Request capture while I allow it',
};

export function pluralItems(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

const rtf =
  typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl
    ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
    : null;

/** "5 minutes ago", "yesterday", or a date. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (!rtf) return new Date(t).toLocaleString();
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86_400 * 14) return rtf.format(Math.round(diff / 86_400), 'day');
  return formatDate(iso);
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
