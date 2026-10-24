import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ROUTES } from '../../domain/src/schemas/routes';
import { OAuthExchange } from '../../domain/src/schemas/agent-platform';
import type { RouteContract } from '../../domain/src/schemas/routes';
import { TOOLS } from './tools';
import { SCOPES, type Scope } from '../../domain/src/enums';
import { CaptureCommandResponse, CommandAck, NativeCommandBatch } from '../../domain/src/schemas/agent-commands';
import * as Shares from '../../domain/src/schemas/collection-shares';
import * as Platform from '../../domain/src/schemas/agent-platform';
import { AgentConnectionDto } from '../../domain/src/schemas/agent-connections';
import { AgentAnalysisResponse, AgentOperationResponse } from '../../domain/src/schemas/agent-media';

/** Tool catalog version: bump on any tool addition or input change. */
export const TOOL_CATALOG_VERSION = '2.2.0';

/** Named JSON Schemas published under docs/api/schemas/ (and in components.schemas). */
export const NAMED_SCHEMAS: Record<string, z.ZodType> = {
  SetupResponse: Platform.SetupResponse,
  PreferencesResponse: Platform.PreferencesResponse,
  OrdinaryPreferencesPatch: Platform.PatchOrdinaryPreferences,
  CreateAgentConnection: Platform.CreateAgentV2,
  NarrowAgentConnection: Platform.NarrowAgentV2,
  AgentConnection: AgentConnectionDto,
  AgentActivity: Platform.AgentActivityResponse,
  OAuthConsent: Platform.OAuthConsent,
  OAuthTokenRequest: OAuthExchange,
  CaptureCommandResponse,
  CommandAck,
  AgentOperation: AgentOperationResponse,
  AgentAnalysis: AgentAnalysisResponse,
  CollectionShare: Shares.ShareDto,
  CreateShareRequest: Shares.CreateShareRequest,
  UpdateShareRequest: Shares.UpdateShareRequest,
  CreateInvitationRequest: Shares.CreateInvitationRequest,
  CreateInvitationResponse: Shares.CreateInvitationResponse,
  RedeemShareRequest: Shares.RedeemShareRequest,
  SharedCollection: Shares.SharedCollectionResponse,
};

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
export function buildAgentContract() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [name, route] of Object.entries(ROUTES)) {
    if (!route.path.startsWith('/v2/')) continue;
    const r: RouteContract = route;
    const parameters: unknown[] = [];
    for (const match of r.path.matchAll(/\{(\w+)\}/g)) parameters.push({ name: match[1], in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
    if (r.query) {
      const query = schema(r.query);
      for (const [key, value] of Object.entries(query.properties ?? {})) parameters.push({ name: key, in: 'query', schema: value });
    }
    if (r.method !== 'GET') parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } });
    if (r.method === 'PATCH' && (r.path === '/v2/me/preferences' || r.path === '/v2/shares/{id}')) parameters.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string', pattern: '^"[1-9][0-9]*"$' } });
    const security = r.path === '/v2/shared/redeem' ? []
      : r.path.startsWith('/v2/shared/') && r.auth === 'public' ? [{ shareSession: [] }, { accountSession: [] }]
        : r.auth === 'owner' ? [{ accountSession: [] }] : [{ bearerAuth: [] }, { accountSession: [] }];
    const op = {
      operationId: name, security,
      'x-required-scopes': r.scopes, parameters,
      ...(r.body instanceof z.ZodType ? { requestBody: { required: true, content: { 'application/json': { schema: schema(r.body) } } } } : {}),
      responses: {
        [r.status]: { description: 'Authorized result', ...(r.response ? { content: { 'application/json': { schema: schema(r.response) } } } : {}) },
        '401': { description: 'Invalid, expired or revoked credential' }, '403': { description: 'Missing permission' },
        '404': { description: 'Missing or inaccessible resource' }, '412': { description: 'Version (If-Match) changed' },
        '429': { description: 'Rate limit, see Retry-After' },
      },
    };
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  paths['/v2/oauth/token'] = { post: { operationId: 'oauthToken', security: [], requestBody: {
    required: true, content: { 'application/json': { schema: schema(OAuthExchange) } },
  }, responses: { '200': { description: '10-minute bearer and rotating refresh, no-store' }, '401': { description: 'Generic invalid grant' } } } };
  paths['/v2/events'] = { get: { operationId: 'agentEvents', security: [{ bearerAuth: [] }], parameters: [
    { name: 'after_cursor', in: 'query', schema: { type: 'string', maxLength: 1024 } },
  ], responses: { '200': { description: 'Resumable scoped batches, grant rechecked every second, no media URLs',
    content: { 'text/event-stream': { schema: { type: 'string' } } } }, '410': { description: 'Cursor expired, resync current state' } } } };
  const binary = (description: string) => ({ description, content: { 'application/octet-stream': { schema: { type: 'string', contentMediaType: 'application/octet-stream' } } } });
  const idParams = (...names: string[]) => names.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
  const range = { name: 'Range', in: 'header', schema: { type: 'string', pattern: '^bytes=[0-9]*-[0-9]*$' } };
  paths['/v2/shared/media/{id}/{variant}'] = { get: { operationId: 'getSharedMedia', security: [{ shareSession: [] }, { accountSession: [] }],
    'x-required-scopes': [], parameters: [...idParams('id', 'variant'), { name: 'share', in: 'query', schema: { type: 'string', format: 'uuid' } }, range],
    description: 'Recipient media gateway. Grant, collection membership and policy are checked on every request; each response is at most one ~30-second segment (<= 8 MiB). variant: poster | playback | original (original only when the owner allowed it).',
    responses: { '200': binary('Whole small object'), '206': binary('One authorized segment'), '404': { description: 'Not shared, revoked, expired or not visible' }, '416': { description: 'Unsatisfiable range' } } } };
  paths['/v2/agent-media/{id}/content/{variant}'] = { get: { operationId: 'getAgentMediaContent', security: [{ bearerAuth: [] }],
    'x-required-scopes': ['media:read'], parameters: [...idParams('id', 'variant'), range],
    description: 'Preview/playback links returned by get_media. variant=original additionally requires media:download and is audited.',
    responses: { '200': binary('Media bytes'), '206': binary('Requested range'), '403': { description: 'Missing permission' }, '404': { description: 'Missing or outside the live grant' } } } };
  paths['/v2/device/commands'] = { get: { operationId: 'claimDeviceCommands', security: [{ installationSession: [] }],
    'x-required-scopes': [], parameters: [{ name: 'after_sequence', in: 'query', schema: { type: 'integer', minimum: 0 } }, { name: 'wait', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 25 } }],
    responses: { '200': { description: 'Commands re-authorized at claim', content: { 'application/json': { schema: schema(NativeCommandBatch) } } }, '401': { description: 'Not an enrolled installation session' } } } };
  paths['/v2/device/commands/{id}/ack'] = { post: { operationId: 'acknowledgeDeviceCommand', security: [{ installationSession: [] }],
    'x-required-scopes': [], parameters: [...idParams('id'), { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', format: 'uuid' } }],
    requestBody: { required: true, content: { 'application/json': { schema: schema(CommandAck) } } },
    responses: { '200': { description: 'Ordered acknowledgement', content: { 'application/json': { schema: schema(CaptureCommandResponse) } } },
      '404': { description: 'Not a command for this installation' }, '409': { description: 'Invalid transition or action_required' } } } };
  return {
    openapi: '3.1.0', info: { title: 'Culture Atlas agent platform', version: '2.1.1' },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    servers: [{ url: 'https://your-atlas.example' }], paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, accountSession: {
      type: 'apiKey', in: 'cookie', name: 'ca_session', description: 'Owner browser session. Mutations also require x-csrf-token and X-Atlas-Expected-Account.',
    }, shareSession: {
      type: 'apiKey', in: 'cookie', name: 'ca_share', description: 'HttpOnly, SameSite=Strict share session scoped to /v2/shared, issued by POST /v2/shared/redeem. Never an agent credential.',
    }, installationSession: {
      type: 'http', scheme: 'bearer', description: 'Enrolled native installation session (cna_...). Cookies and agent tokens are refused.',
    } }, schemas: Object.fromEntries(Object.entries(NAMED_SCHEMAS).map(([k, v]) => [k, schema(v)])) },
  };
}
export function buildToolCatalog() {
  return {
    schema_version: '2.1', catalog_version: TOOL_CATALOG_VERSION,
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, scopes: t.scopes, input_schema: schema(t.input) })),
  };
}

/** Every generated file under docs/api, keyed by relative path (used by the drift test). */
export function buildAgentContractFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'agent-platform.openapi.json': `${JSON.stringify(buildAgentContract(), null, 2)}\n`,
    'agent-tools-v2.json': `${JSON.stringify(buildToolCatalog(), null, 2)}\n`,
  };
  for (const [name, value] of Object.entries(NAMED_SCHEMAS)) {
    files[`schemas/${name}.json`] = `${JSON.stringify({ $id: `https://culture-atlas.invalid/schemas/v2/${name}.json`, title: name, ...schema(value) }, null, 2)}\n`;
  }
  return files;
}

/** Plain-language meaning of every grantable scope (docs/agents.md reference). */
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  'captures:read': 'Read photo captures, their interpretation, references and recommendations.',
  'captures:write': 'Upload photos (`POST /v1/uploads`) and start photo analysis (`analyze_capture`).',
  'collections:read': 'List and read granted collections (boards) and their items.',
  'collections:write': 'Add or remove items in granted collections; with whole-library access, create collections.',
  'taste:read': 'Read the explicit interest summary (selected-collection grants must pass `collection_id`).',
  'taste:write': 'Save, unsave, hide or unhide items when the user explicitly asks.',
  'plans:read': 'Read plans and their sections.',
  'plans:write': 'Create plans and replace one plan section.',
  'setup:read': 'Read safe device capabilities and aliases. Never grants OS permissions.',
  'preferences:read': 'Read ordinary preferences (theme, language, exploration, food exclusions). Not taste.',
  'preferences:write': 'Change ordinary preferences. Cannot enable capture, microphones, sharing or automatic analysis.',
  'media:read': 'List and view permitted media and its preview links (absolute URLs).',
  'media:download': 'Download originals of permitted media.',
  'media:write': 'Begin and complete signed media uploads into a granted destination.',
  'media:analyze': 'Explicitly request analysis of permitted media (never automatic).',
  'devices:command': 'Request capture on an explicitly granted, locally armed phone.',
};

export const AGENTS_REFERENCE_START = '<!-- generated:agent-reference:start (pnpm exec tsx scripts/generate-agent-contract.ts) -->';
export const AGENTS_REFERENCE_END = '<!-- generated:agent-reference:end -->';

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The generated scope and tool reference embedded in docs/agents.md. */
export function buildAgentsReference(): string {
  const lines: string[] = [
    AGENTS_REFERENCE_START,
    '',
    `### Scopes (${SCOPES.length})`,
    '',
    'Every scope below is accepted by `POST /v2/agent-connections` and the OAuth consent, and is listed in `/.well-known/oauth-protected-resource/mcp`.',
    '',
    '| Scope | What it allows |',
    '| --- | --- |',
    ...SCOPES.map((scope) => `| \`${scope}\` | ${cell(SCOPE_DESCRIPTIONS[scope])} |`),
    '',
    `### MCP tools (${TOOLS.length}, catalog ${TOOL_CATALOG_VERSION})`,
    '',
    '| Tool | Scopes | Returns | What it does |',
    '| --- | --- | --- | --- |',
    ...TOOLS.map((t) => {
      const scopes = t.scopes.length ? t.scopes.map((x) => `\`${x}\``).join(', ') : 'none (grant-checked)';
      return `| \`${t.name}\` | ${scopes} | ${t.startsJob ? 'job_id (poll `get_job`)' : 'result'} | ${cell(t.description)} |`;
    }),
    '',
    AGENTS_REFERENCE_END,
  ];
  return lines.join('\n');
}

/** docs/agents.md with its generated reference block replaced by the current one. */
export function withAgentsReference(markdown: string): string {
  const start = markdown.indexOf(AGENTS_REFERENCE_START);
  const end = markdown.indexOf(AGENTS_REFERENCE_END);
  if (start < 0 || end < start) throw new Error('docs/agents.md is missing the generated reference markers');
  return `${markdown.slice(0, start)}${buildAgentsReference()}${markdown.slice(end + AGENTS_REFERENCE_END.length)}`;
}

export async function generateAgentContract(root: string) {
  const output = resolve(root, 'docs/api');
  await mkdir(resolve(output, 'schemas'), { recursive: true });
  for (const [path, body] of Object.entries(buildAgentContractFiles())) await writeFile(resolve(output, path), body);
  const agentsDoc = resolve(root, 'docs/agents.md');
  await writeFile(agentsDoc, withAgentsReference(await readFile(agentsDoc, 'utf8')));
}
