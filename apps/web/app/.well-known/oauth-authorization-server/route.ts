import { getDomainConfig } from '@culture-atlas/domain';

export function GET() {
  const base = getDomainConfig().APP_BASE_URL.replace(/\/+$/, '');
  return Response.json({
    issuer: base, authorization_endpoint: `${base}/settings/agents/authorize`, token_endpoint: `${base}/v2/oauth/token`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
  }, { headers: { 'cache-control': 'no-store' } });
}
