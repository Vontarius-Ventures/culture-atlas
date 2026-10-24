import { getDomainConfig, SCOPES } from '@culture-atlas/domain';

/**
 * RFC 9728 protected-resource metadata for the MCP endpoint. `scopes_supported`
 * is derived from the domain SCOPES list (everything the v2 consent accepts),
 * so it cannot drift from what a connection can actually be granted.
 */
export function GET() {
  const base = getDomainConfig().APP_BASE_URL.replace(/\/+$/, '');
  return Response.json({
    resource: `${base}/mcp`, authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SCOPES],
  }, { headers: { 'cache-control': 'no-store' } });
}
