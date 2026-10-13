import path from 'node:path';
import type { NextConfig } from 'next';

const root = path.resolve(import.meta.dirname, '../..');
// Load the repo-root .env (Next only reads apps/web/.env* by itself). Existing vars win.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // no root .env
}

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@culture-atlas/domain', '@culture-atlas/providers', '@culture-atlas/agent-gateway'],
  // Native / Node-only modules stay external to the server bundle.
  serverExternalPackages: ['pg', 'sharp'],
  turbopack: { root },
  outputFileTracingRoot: root,
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
