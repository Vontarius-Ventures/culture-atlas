import { getDomainConfig } from '@culture-atlas/domain';

export function GET() {
  const base = getDomainConfig().APP_BASE_URL.replace(/\/+$/, '');
  return Response.json({
    resource: `${base}/mcp`, authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['setup:read', 'preferences:read', 'preferences:write', 'media:read', 'media:download',
      'media:write', 'media:analyze', 'collections:read', 'collections:write', 'devices:command', 'plans:read', 'plans:write'],
  }, { headers: { 'cache-control': 'no-store' } });
}
