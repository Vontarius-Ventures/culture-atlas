import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Thin MCP client for the culture atlas endpoint. Bearer auth only; the agent
 * never sees the database or the domain packages.
 */

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  request_id?: string;
  details?: unknown;
}

export type ToolOutcome<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; error: ToolError };

export interface ToolCaller {
  callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<ToolOutcome<T>>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Thrown when the endpoint refuses the connection itself (missing/expired/revoked token). */
export class ConnectionRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionRefusedError';
  }
}

/** Wrap fetch so HTTP-level auth failures surface with the service's error code. */
function checkedFetch(base: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await base(input, init);
    if (res.status === 401 || res.status === 403) {
      let code = res.status === 401 ? 'unauthenticated' : 'scope_denied';
      let message = res.statusText;
      try {
        const body = (await res.clone().json()) as { code?: string; message?: string };
        code = body.code ?? code;
        message = body.message ?? message;
      } catch {
        // non-JSON body
      }
      throw new ConnectionRefusedError(res.status, code, message);
    }
    return res;
  };
}

export async function connectMcp(options: { url: string; token: string; fetch?: FetchLike; clientName?: string }): Promise<ToolCaller> {
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
    fetch: checkedFetch(options.fetch ?? ((i, init) => fetch(i, init))),
  });
  const client = new Client({ name: options.clientName ?? 'culture-atlas-demo-agent', version: '0.1.0' });
  await client.connect(transport);

  return {
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<ToolOutcome<T>> {
      const result = await client.callTool({ name, arguments: args });
      const structured = (result.structuredContent ?? null) as Record<string, unknown> | null;
      if (result.isError) {
        const err = (structured?.error ?? null) as ToolError | null;
        const text = Array.isArray(result.content) ? result.content.map((c) => ('text' in c ? c.text : '')).join(' ') : '';
        return { ok: false, error: err ?? { code: 'unknown', message: text || 'Tool call failed', retryable: false } };
      }
      return { ok: true, data: (structured ?? {}) as T };
    },
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    },
    async close() {
      await client.close();
    },
  };
}
