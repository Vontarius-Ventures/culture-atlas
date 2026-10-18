/**
 * Pure logic for the taste onboarding screens (spec amendment 2.2, screens
 * 14, 15 and 18) and the global onboarding redirect. Framework-free so the
 * rules are unit-tested (client-logic.test.ts) and shared by the views.
 */
import type { Category, ItemKind } from '@culture-atlas/domain';
import {
  ONBOARDING_MIN_PICKS,
  type OnboardingPick,
  type SessionResponse,
  type TasteSeedStatus,
} from '@culture-atlas/domain/schemas';
import { COPY } from '@/components/v2/copy';
import { CATEGORY_LABELS } from './format';

export const MIN_PICKS = ONBOARDING_MIN_PICKS;
export const ONBOARDING_PATH = '/welcome/taste';
export const BUILDING_PATH = '/welcome/building';

/** Counter copy: "3 picks to go" … "1 pick to go", then "Ready". Exclusions never count. */
export function counterText(picks: number): string {
  const left = MIN_PICKS - picks;
  if (left <= 0) return COPY['onboarding.counter.ready'];
  if (left === 1) return COPY['onboarding.counter.1'];
  if (left === 2) return COPY['onboarding.counter.2'];
  return COPY['onboarding.counter.3'];
}

export function stepLabel(step: number): string {
  return COPY['onboarding.step'].replace('{n}', String(step));
}

export function clampStep(raw: string | null | undefined): 1 | 2 | 3 {
  const n = Number(raw);
  return n === 2 ? 2 : n === 3 ? 3 : 1;
}

/**
 * Paths that stay reachable while an account still owes the questionnaire:
 * the questionnaire itself, the email sign-in callback, and shared-collection
 * viewers (which are not the owner's feed).
 */
const ONBOARDING_EXEMPT = /^\/(welcome|identity|shared)(\/|$)/;

/**
 * Where the shell must send this session, or null. Only signed-in accounts
 * with `onboarding_required` are redirected; anonymous visitors never see the
 * questionnaire (ONB-01) and the server decides the flag (sign-up, the
 * existing-account sign-in trigger, and the onboarding_required kill switch).
 */
export function onboardingRedirect(
  pathname: string,
  session: Pick<SessionResponse, 'principal' | 'onboarding_required'> | null,
): string | null {
  if (!session || session.principal.kind !== 'account') return null;
  if (!session.onboarding_required) return null;
  if (ONBOARDING_EXEMPT.test(pathname)) return null;
  return ONBOARDING_PATH;
}

/** "Peanuts" for the stored "peanuts"; free text keeps what the person typed. */
export function exclusionLabel(term: string): string {
  return term ? term.charAt(0).toUpperCase() + term.slice(1) : term;
}

/** Normalizes a free-text exclusion; null when empty or a duplicate. */
export function normalizeExclusion(raw: string, existing: readonly string[]): string | null {
  const term = raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 40);
  if (!term) return null;
  if (existing.some((e) => e.toLowerCase() === term)) return null;
  return term;
}

/** Toggles a term in an exclusion list (plan-constraint limit of 12 items). */
export function toggleExclusion(list: readonly string[], term: string, max = 12): string[] {
  const has = list.some((e) => e.toLowerCase() === term.toLowerCase());
  if (has) return list.filter((e) => e.toLowerCase() !== term.toLowerCase());
  if (list.length >= max) return [...list];
  return [...list, term];
}

const SEARCH_KIND_LABELS: Partial<Record<ItemKind, string>> = {
  artist: 'Artist',
  film: 'Film',
  brand: 'Brand',
  food: 'Place',
  style: 'Style',
  track: 'Track',
};

/**
 * The small second line of a pick (collage tiles and Settings chips): the
 * group for catalog picks ("Wear"), the type for search picks ("Artist").
 */
export function pickKindLabel(
  pick: Pick<OnboardingPick, 'source' | 'category' | 'item_kind'>,
): string | null {
  if (pick.source === 'search' || pick.source === 'pending_save')
    return SEARCH_KIND_LABELS[pick.item_kind] ?? null;
  return pick.category ? CATEGORY_LABELS[pick.category] : null;
}

export type CategoryProgress = { category: Category; label: string; ready: boolean; state: string };

export interface SeedView {
  /** Per-category chips on screen 15 (Ready / Looking). */
  categories: CategoryProgress[];
  /** The first category is ready: move to Discover. */
  advance: boolean;
  /** Qloo could not be reached (or the job gave up): "We'll keep building in the background." */
  unavailable: boolean;
  /** Nothing to wait for (finished with nothing ready, or no seed job): go to Discover. */
  done: boolean;
}

const ORDER: Category[] = ['wear', 'play', 'watch', 'eat'];

/**
 * Screen 15 state from GET /v1/onboarding/seed. Never invents progress: a
 * category is Ready only when the server says it holds real recommendations.
 */
export function seedView(seed: TasteSeedStatus | null, timedOut = false): SeedView {
  const byCat = new Map(seed?.categories.map((c) => [c.category, c]) ?? []);
  const categories = ORDER.map((category) => {
    const c = byCat.get(category);
    const ready = c?.state === 'ready' && c.card_count > 0;
    return { category, label: CATEGORY_LABELS[category], ready, state: c?.state ?? 'pending' };
  });
  const anyReady = categories.some((c) => c.ready);
  const state = seed?.state ?? 'queued';
  const terminal = state === 'complete' || state === 'partial' || state === 'failed';
  const unavailable =
    !anyReady &&
    (state === 'retrying' ||
      state === 'failed' ||
      timedOut ||
      (categories.some((c) => c.state === 'unavailable') &&
        !categories.some((c) => c.state === 'pending')));
  return {
    categories,
    advance: anyReady,
    unavailable,
    done: !anyReady && !unavailable && (terminal || state === 'not_started'),
  };
}

/** Poll delay for the seed status (server hint wins, bounded). */
export function seedPollDelay(seed: TasteSeedStatus | null): number {
  const hint = seed?.poll_after_ms;
  if (typeof hint === 'number') return Math.min(Math.max(hint, 500), 5000);
  return 1000;
}

/** Title badge while the tab is hidden and a photo finished (screen 17). */
export function readyTitle(count: number): string {
  return COPY['ready.title_badge'].replace('{n}', String(count));
}
