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
  VLM_READING_VERSIONS,
  type ModelProfile,
  type StructuredTransport,
} from '@culture-atlas/providers';

if (process.env.NODE_ENV === 'production') throw new Error('e2e-fake-models is for browser tests only');

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

const profiles: Record<'vision_photo' | 'vision_photo_enrich', ModelProfile> = {
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
};

const QUICK = {
  title: 'Sesame noodle supper',
  interpretation: 'A bowl of noodles that resembles a Sichuan street-food supper.',
  candidates: [
    { name: 'Dan dan noodles', type: 'cuisine', relation: 'resembles', certainty: 0.85, categories: ['eat'], tag_query: 'Sichuan cuisine' },
    { name: 'Wabi-sabi', type: 'style', relation: 'resembles', certainty: 0.55, categories: ['wear'], tag_query: 'wabi sabi' },
    { name: 'Film noir', type: 'style', relation: 'resembles', certainty: 0.4, categories: ['watch'], tag_query: 'film noir' },
    { name: 'Bossa nova', type: 'style', relation: 'resembles', certainty: 0.35, categories: ['play'], tag_query: 'bossa nova' },
  ],
  quality: { usable: true, issue: null },
};

const ENRICHMENT = {
  observations: [
    { text: 'Chili oil pooled around hand-pulled noodles', kind: 'food' },
    { text: 'Rough stoneware bowl on a dark wooden table', kind: 'object' },
  ],
  visible_text: [],
  confirmed: [
    { name: 'Dan dan noodles', rationale: 'Minced pork, chili oil and scallions on noodles', keep: true },
    { name: 'Wabi-sabi', rationale: 'Hand-thrown bowl with an uneven glaze', keep: true },
  ],
  additional_candidates: [
    { name: 'Izakaya', type: 'tradition', relation: 'resembles', certainty: 0.4, categories: ['eat'], tag_query: 'izakaya', rationale: 'Late-night bar food setting' },
  ],
  regions: [],
  uncertainty: { overall: 'low', notes: [] },
  competing_subjects: [],
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

const transport: StructuredTransport = async (request, { signal }) => {
  const quick = request.schemaName === VLM_READING_VERSIONS.quick.schema;
  const enrich = request.schemaName === VLM_READING_VERSIONS.enrich.schema;
  await sleep(quick ? quickDelayMs : enrichDelayMs, signal);
  if (!quick && !enrich) return { id: null, model: request.model, actualProvider: 'fixture', text: '', outcome: 'error', usage: null };
  return {
    id: `resp_e2e_${Date.now()}`,
    requestId: `req_e2e_${Date.now()}`,
    model: request.model,
    actualProvider: 'fixture',
    text: JSON.stringify(quick ? QUICK : ENRICHMENT),
    outcome: 'complete',
    usage: { inputTokens: 1200, outputTokens: quick ? 320 : 640 },
  };
};

// The gateway needs a key to exist; the injected transport never sends it anywhere.
process.env.CONCENTRATE_API_KEY ||= 'e2e-fake-transport-no-network';
// The fixture route has no price, so every call settles as unknown spend: leave room for many test runs.
process.env.MODEL_DAILY_SPEND_LIMIT_USD ||= '10';
process.env.MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD ||= '1';
process.env.MODEL_MAX_UNKNOWN_SPEND_USD ||= '5';

configureProviderRuntime({ gateway: { profiles, transport, qualification: () => 'qualified' } });
console.log('[worker] e2e: fake model transport (no network), roles vision_photo + vision_photo_enrich');
await import('./main');
