import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const composePath = `${root}/docker-compose.yml`;
const renderPath = `${root}/render.yaml`;

describe('self-host Compose (default; Render is paid)', () => {
  it('describes postgres, web, worker, media-worker and a shared objects volume', () => {
    const text = readFileSync(composePath, 'utf8');
    expect(text).not.toMatch(/\brc_[A-Za-z0-9]/);
    expect(text).not.toMatch(/\bsk-[A-Za-z0-9]/);
    expect(text).not.toMatch(/AKIA[A-Z0-9]{16}/);
    const doc = parse(text, { merge: true }) as {
      services: Record<string, { ports?: unknown; command?: unknown; environment?: Record<string, string> }>;
      volumes: Record<string, unknown>;
    };
    expect(Object.keys(doc.services)).toEqual(
      expect.arrayContaining(['postgres', 'web', 'worker', 'media-worker']),
    );
    expect(doc.volumes).toHaveProperty('objects');
    expect(doc.volumes).toHaveProperty('pgdata');
    const web = doc.services.web!;
    expect(JSON.stringify(web.ports)).toMatch(/0\.0\.0\.0/);
    expect(web.environment?.LLM_PROVIDER).toBe('concentrate');
    expect(web.environment?.QLOO_API_URL).toMatch(/hackathon\.api\.qloo\.com/);
    expect(web.environment?.CONCENTRATE_API_KEY).toMatch(/CONCENTRATE_API_KEY/);
    expect(web.environment?.QLOO_API_KEY).toMatch(/QLOO_API_KEY/);
    expect(web.environment?.FEATHERLESS_API_KEY).toMatch(/FEATHERLESS_API_KEY/);
    expect(web.environment?.STORAGE_DRIVER).toBe('local');
  });

  it('does not treat Render workers as free', () => {
    const render = readFileSync(renderPath, 'utf8');
    expect(render).toMatch(/not free|no free plan/i);
    expect(render).toMatch(/LLM_PROVIDER/);
    expect(render).toMatch(/CONCENTRATE_BASE_URL/);
    expect(render).toMatch(/QLOO_API_URL/);
    expect(render).not.toMatch(/\brc_[A-Za-z0-9]/);
  });
});
