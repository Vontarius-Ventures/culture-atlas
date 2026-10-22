import { z } from 'zod';
import { CatalogSnapshotSchema, type CatalogSnapshot } from './profiles';

const CONCENTRATE_API = 'https://api.concentrate.ai/v1';
const MAX_PAGES = 50;

const Page = z
  .object({
    data: z.array(z.object({ id: z.string().min(1) }).loose()),
    has_more: z.boolean().optional(),
    last_id: z.string().nullable().optional(),
  })
  .loose();

/**
 * `GET /v1/models`, following has_more with the last id as the `after`
 * cursor. Catalog metadata only (not inference). Used by the operator
 * qualification script, never by health checks or request paths.
 */
export async function fetchCatalogSnapshot(input: {
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<CatalogSnapshot> {
  const doFetch = input.fetch ?? fetch;
  const models: Array<{ id: string } & Record<string, unknown>> = [];
  let after: string | undefined;
  let pages = 0;
  for (;;) {
    if (++pages > MAX_PAGES) throw new Error('Catalog pagination did not terminate.');
    const url = new URL(`${CONCENTRATE_API}/models`);
    if (after) url.searchParams.set('after', after);
    const res = await doFetch(url.toString(), {
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: 'application/json' },
      redirect: 'error',
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Catalog request failed with HTTP ${res.status}.`);
    }
    const page = Page.parse(await res.json());
    models.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    const next = page.last_id ?? page.data[page.data.length - 1]!.id;
    if (next === after) throw new Error('Catalog cursor did not advance.');
    after = next;
  }
  return CatalogSnapshotSchema.parse({
    kind: 'concentrate-catalog-snapshot',
    fetched_at: (input.now?.() ?? new Date()).toISOString(),
    pages,
    models,
  });
}

/**
 * Live catalog pin from 2026-10-22 (`GET /v1/models`, 204 models).
 * ZDR listed as a policy object on `providers.anthropic` (certificate URL present),
 * `capabilities.image_input.supported`, JPEG in `image_processing.supported_formats`,
 * and `capabilities.structured_outputs.supported`.
 *
 * This is not a dispatch default. `DEFAULT_MODELS.concentrate` stays empty so a
 * marketing-page example cannot silently ride along; set `VLM_MODEL` /
 * `RESEARCH_MODEL` / `COMPOSER_MODEL` as assertions against a profile file after
 * the operator confirms dashboard ZDR / no content logging. Photo-role quality
 * qualification remains fail-closed (no unused golden-v5 blind split).
 */
export const PINNED_CONCENTRATE_ROUTES = {
  catalogFetchedAt: '2026-10-22T03:13:03.746Z',
  vision: { model: 'anthropic/claude-haiku-5-5', provider: 'anthropic', id: 'claude-haiku-5-5' },
  text: { model: 'anthropic/claude-haiku-5-5', provider: 'anthropic', id: 'claude-haiku-5-5' },
} as const;

export interface EligibleConcentrateRoute {
  /** Exact `provider/id` pin, same form as `ModelProfile.model`. */
  model: string;
  provider: string;
  id: string;
  vision: boolean;
  structured: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function capabilitySupported(entry: CatalogSnapshot['models'][number], key: string): boolean {
  return asRecord(asRecord(entry.capabilities)?.[key])?.supported === true;
}

function providerZdrListed(route: unknown): boolean {
  const zdr = asRecord(route)?.zdr;
  return !!asRecord(zdr);
}

function jpegListed(route: unknown): boolean {
  const formats = asRecord(asRecord(route)?.image_processing)?.supported_formats;
  return (
    Array.isArray(formats) &&
    formats.some((f) => typeof f === 'string' && /^(jpe?g)$/i.test(f))
  );
}

/**
 * Provider/model pairs that satisfy Atlas privacy + modality policy from catalog
 * metadata only: ZDR listed as a policy object (boolean `false` is ineligible),
 * structured output, and — for vision — image input plus JPEG. Content logging
 * is a key/dashboard setting, not a catalog field.
 */
export function listEligibleConcentrateRoutes(snapshot: CatalogSnapshot): EligibleConcentrateRoute[] {
  const out: EligibleConcentrateRoute[] = [];
  for (const entry of snapshot.models) {
    const providers = asRecord(entry.providers);
    if (!providers) continue;
    const structured = capabilitySupported(entry, 'structured_outputs');
    if (!structured) continue;
    const image = capabilitySupported(entry, 'image_input');
    for (const [provider, route] of Object.entries(providers)) {
      if (!providerZdrListed(route)) continue;
      const vision = image && jpegListed(route);
      out.push({
        model: `${provider}/${entry.id}`,
        provider,
        id: entry.id,
        vision,
        structured,
      });
    }
  }
  return out;
}

/**
 * Pick one vision-capable and one text route. Prefers the live 2026-10-22 pin
 * when it is still eligible; otherwise the first remaining eligible route.
 * Returns null when either role has no eligible route (fail closed).
 */
export function selectPinnedConcentrateRoutes(
  snapshot: CatalogSnapshot,
): { vision: EligibleConcentrateRoute; text: EligibleConcentrateRoute } | null {
  const eligible = listEligibleConcentrateRoutes(snapshot);
  const vision =
    eligible.find((r) => r.vision && r.model === PINNED_CONCENTRATE_ROUTES.vision.model) ??
    eligible.find((r) => r.vision);
  const text =
    eligible.find((r) => r.model === PINNED_CONCENTRATE_ROUTES.text.model) ??
    eligible.find((r) => r.model === vision?.model) ??
    eligible.find((r) => r.structured);
  if (!vision || !text) return null;
  return { vision, text };
}
