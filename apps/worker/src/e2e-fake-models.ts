/**
 * BROWSER-TEST ENTRY ONLY (docs/v22-real-stack.md). Starts the normal worker
 * (src/main.ts) with the Concentrate gateway's HTTP transport replaced by a
 * deterministic in-process stand-in, so the real-stack journey can exercise
 * the two-stage reading (quick read, then enrichment), the spend ledger,
 * account-only model identity, While we look and the ready notice without a
 * qualified live model. Nothing leaves the process and no key is used.
 *
 * Refuses to start with NODE_ENV=production. The readings it returns are test
 * fixtures for one known test photo; they are never shown outside tests.
 */
import {
  configureProviderRuntime,
  STYLE_MAX_OUTPUT_TOKENS,
  STYLE_PROMPT_VERSION,
  STYLE_WIRE_SCHEMA,
  VLM_READING_VERSIONS,
  type CatalogSnapshot,
  type ModelProfile,
  type StructuredTransport,
} from '@culture-atlas/providers';
import { pathToFileURL } from 'node:url';

const quickDelayMs = Number(process.env.E2E_FAKE_QUICK_MS ?? 6000);
const enrichDelayMs = Number(process.env.E2E_FAKE_ENRICH_MS ?? 2500);

const base: Omit<ModelProfile, 'role' | 'version' | 'promptVersion' | 'schemaVersion' | 'maxOutputTokens' | 'image' | 'timeoutMs'> = {
  gateway: 'concentrate',
  model: 'fixture/e2e-vision',
  provider: 'fixture',
  allowedFallbackProviders: [],
  reasoningEffort: 'none',
  maxInputTokens: 20_000,
  maxInputBytes: 400_000,
  structuredOutput: true,
  requireZdr: true,
  providerZdrEligible: true,
  contentLoggingEnabled: false,
  privacyVerifiedAt: '2026-10-18T00:00:00Z',
  catalogSnapshotAt: '2026-10-18T00:00:00Z',
  qualificationArtifactId: 'e2e-fake-only',
  pricingSnapshotVersion: 'e2e-fake',
  reservationMicros: 5_000,
};

/** Synthetic price metadata for the in-process fixture, never a live catalogue. */
export const E2E_MODEL_CATALOG: CatalogSnapshot = {
  kind: 'concentrate-catalog-snapshot',
  fetched_at: '2026-10-18T00:00:00Z',
  pages: 1,
  models: [{
    id: 'fixture/e2e-vision',
    providers: { fixture: { pricing: [{ tokens: {
      input: { price: { USD: 0.1 }, units: 1_000_000 },
      output: { price: { USD: 0.1 }, units: 1_000_000 },
    } }] } },
  }],
};

export const E2E_MODEL_PROFILES: Record<'vision_photo' | 'vision_photo_enrich' | 'vision_style', ModelProfile> = {
  vision_photo: {
    ...base,
    role: 'vision_photo',
    version: 'e2e-quick-1',
    promptVersion: VLM_READING_VERSIONS.quick.prompt,
    schemaVersion: VLM_READING_VERSIONS.quick.schema,
    maxOutputTokens: 600,
    image: { maxBytes: 250_000, maxPixels: 262_144, maxDimension: 512, maxCount: 1 },
    timeoutMs: 15_000,
  },
  vision_photo_enrich: {
    ...base,
    role: 'vision_photo_enrich',
    version: 'e2e-enrich-1',
    promptVersion: VLM_READING_VERSIONS.enrich.prompt,
    schemaVersion: VLM_READING_VERSIONS.enrich.schema,
    maxOutputTokens: 1200,
    image: { maxBytes: 250_000, maxPixels: 589_824, maxDimension: 768, maxCount: 1 },
    timeoutMs: 20_000,
  },
  // The compiler now requires an independently read subject before it can
  // admit recommendations. This is a synthetic qualified route only inside
  // the test transport, not a production qualification or gate override.
  vision_style: {
    ...base,
    role: 'vision_style',
    version: 'e2e-style-1',
    promptVersion: STYLE_PROMPT_VERSION,
    schemaVersion: STYLE_WIRE_SCHEMA,
    maxOutputTokens: STYLE_MAX_OUTPUT_TOKENS,
    image: { maxBytes: 350_000, maxPixels: 1_048_576, maxDimension: 1024, maxCount: 1 },
    timeoutMs: 18_000,
  },
};

const QUICK = {
  title: 'Sesame noodle supper',
  interpretation: 'A bowl of noodles that resembles a Sichuan street-food supper.',
  candidates: [
    { name: 'Dan dan noodles', type: 'cuisine', relation: 'resembles', certainty: 0.85, categories: ['eat'], tag_query: 'Sichuan cuisine' },
  ],
  quality: { usable: true, issue: null },
};

const ENRICHMENT = {
  observations: [
    { text: 'Red oil around noodles topped with sliced scallions', kind: 'food' },
    { text: 'Rough stoneware bowl on a dark wooden table', kind: 'object' },
  ],
  visible_text: [],
  confirmed: [
    { name: 'Dan dan noodles', rationale: 'Crumbled topping, red oil and scallions on noodles', keep: true },
  ],
  additional_candidates: [],
  regions: [],
  uncertainty: { overall: 'low', notes: [] },
  competing_subjects: [],
};

/** Describes noodles.jpg without inventing fashion, music or a venue location. */
export const E2E_STYLE_READING = {
  schema: STYLE_WIRE_SCHEMA,
  usable: true,
  unusable_reason: 'none',
  subjects: [{ id: 's1', category: 'food', label: 'Bowl of noodles', box: [0.02, 0.1, 0.95, 0.78], brand_name: '', brand_text: '' }],
  observations: [
    { subject: 's1', id: 'o1', kind: 'form', text: 'Long noodles piled in a round bowl', box: [], certainty: 0.95 },
    { subject: 's1', id: 'o2', kind: 'surface', text: 'Red oil and green sliced scallions on the noodles', box: [], certainty: 0.9 },
  ],
  claims: [],
  palette: [],
  summary: 'Noodles with red oil and sliced scallions in a ceramic bowl.',
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

export function createE2EModelTransport(delay: { quick?: number; enrich?: number; style?: number } = {}): StructuredTransport {
  return async (request, { signal }) => {
    const quick = request.schemaName === VLM_READING_VERSIONS.quick.schema;
    const enrich = request.schemaName === VLM_READING_VERSIONS.enrich.schema;
    const style = request.schemaName === STYLE_WIRE_SCHEMA;
    await sleep(quick ? delay.quick ?? quickDelayMs : style ? delay.style ?? 500 : delay.enrich ?? enrichDelayMs, signal);
    if (!quick && !enrich && !style) return { id: null, model: request.model, actualProvider: 'fixture', text: '', outcome: 'error', usage: null };
    return {
      id: `resp_e2e_${Date.now()}`,
      requestId: `req_e2e_${Date.now()}`,
      model: request.model,
      actualProvider: 'fixture',
      text: JSON.stringify(quick ? QUICK : style ? E2E_STYLE_READING : ENRICHMENT),
      outcome: 'complete',
      usage: { inputTokens: 1200, outputTokens: quick ? 320 : 640 },
    };
  };
}

export async function startE2EModelWorker() {
  if (process.env.NODE_ENV === 'production') throw new Error('e2e-fake-models is for browser tests only');
  // The gateway needs a key to exist; the injected transport never sends it anywhere.
  process.env.CONCENTRATE_API_KEY ||= 'e2e-fake-transport-no-network';
  // Leave room for many fixture runs in their isolated database's spend ledger.
  process.env.MODEL_DAILY_SPEND_LIMIT_USD ||= '10';
  process.env.MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD ||= '1';
  process.env.MODEL_MAX_UNKNOWN_SPEND_USD ||= '5';

  configureProviderRuntime({ gateway: {
    profiles: E2E_MODEL_PROFILES,
    catalog: E2E_MODEL_CATALOG,
    transport: createE2EModelTransport(),
    qualification: () => 'qualified',
  } });
  console.log('[worker] e2e: fake model transport (no network), roles vision_photo + vision_photo_enrich + vision_style');
  await import('./main');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startE2EModelWorker();
