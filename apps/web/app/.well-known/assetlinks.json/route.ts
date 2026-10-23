import { getDomainConfig } from '@culture-atlas/domain';

const STORE_PACKAGES = ['com.cultureatlas.app', 'com.cultureatlas.app.experimental'] as const;

function fingerprints(): string[] {
  const fromEnv = (process.env.ANDROID_ASSETLINKS_SHA256 ?? '')
    .split(',')
    .map((value) => normalizeSha(value))
    .filter(Boolean);
  const debug = process.env.ANDROID_DEBUG_CERT_SHA256?.trim();
  if (getDomainConfig().NODE_ENV !== 'production' && debug) {
    const normalized = normalizeSha(debug);
    if (normalized) fromEnv.push(normalized);
  }
  return [...new Set(fromEnv)];
}

function normalizeSha(value: string): string {
  const hex = value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length !== 64) return '';
  return (hex.match(/.{2}/g) ?? []).join(':');
}

/** Digital Asset Links for Android identity App Links. Empty fingerprints stay honest (no fake certs). */
export function GET() {
  const sha = fingerprints();
  const body = STORE_PACKAGES.map((name) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: name,
      sha256_cert_fingerprints: sha,
    },
  }));
  return Response.json(body, {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
  });
}
