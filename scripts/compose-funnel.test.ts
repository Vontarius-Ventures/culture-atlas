import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, 'utf8');
const compose = parse(read('docker-compose.funnel.yml'), { merge: true });
const edge = read('infra/onprem/Caddyfile.funnel');

describe('isolated Tailscale Funnel edge', () => {
  it('does not publish ports or use the Mac Tailscale socket', () => {
    for (const service of Object.values(compose.services) as Record<string, unknown>[]) {
      expect(service.ports).toBeUndefined();
      expect(service.privileged).not.toBe(true);
      expect(JSON.stringify(service.volumes)).not.toMatch(/docker\.sock|tailscaled\.sock/);
    }
  });

  it('persists the dedicated node without kernel networking privileges', () => {
    const node = compose.services.tailscale;
    expect(node.environment).toMatchObject({
      TS_HOSTNAME: 'culture-atlas',
      TS_STATE_DIR: '/var/lib/tailscale',
      TS_USERSPACE: 'true',
      TS_AUTH_ONCE: 'true',
    });
    expect(node.volumes).toContain('tailscale-state:/var/lib/tailscale');
    expect(node.network_mode).toBe('service:funnel-proxy');
    expect(node.cap_drop).toContain('ALL');
    expect(node.environment.TS_EXTRA_ARGS).toContain('--accept-routes=false');
    expect(node.environment.TS_EXTRA_ARGS).toContain('--accept-dns=false');
  });

  it('forwards app and signed media through separate loopback listeners', () => {
    expect(edge).toContain('http://:3100');
    expect(edge).toContain('http://:3901');
    // Bind to loopback without adding a Host matcher: Funnel preserves the
    // public Host, which is also part of each S3 signature.
    expect(edge.match(/bind 127\.0\.0\.1/g)).toHaveLength(2);
    expect(edge).not.toContain('http://127.0.0.1:');
    expect(edge).toContain('reverse_proxy web:3000');
    expect(edge).toContain('reverse_proxy garage:3900');
    expect(edge).not.toMatch(/header_up\s+Host|rewrite|handle_path/);
    expect(edge).toContain('max_size 20MB');
    expect(edge).toContain('max_size 32MB');
    expect(edge).toContain('trusted_proxies static 127.0.0.1/32 ::1/128');
    expect(edge).toContain('trusted_proxies_strict');
  });

  it('removes inherited host port bindings from the production stack', () => {
    const privateEdge = read('docker-compose.funnel-private.yml');
    expect(privateEdge).toMatch(/web:\s+ports: !reset \[\]/);
    expect(privateEdge).toMatch(/garage:\s+ports: !reset \[\]/);
  });
});
