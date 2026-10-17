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
