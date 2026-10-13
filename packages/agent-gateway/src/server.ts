/**
 * Remote MCP endpoint (mounted by apps/web at /mcp).
 * TODO(agent gateway owner): implement with @modelcontextprotocol/sdk:
 *  - authenticate `Authorization: Bearer cat_...` via domain auth.resolvePrincipal
 *    (agent principals only; anonymous/cookie callers -> 401);
 *  - build a ServiceContext (surface 'mcp') per request;
 *  - register TOOLS (tools.ts) with their zod input schemas; return concise
 *    structured results with ids, short reasons and `evidence_available`;
 *    map AppError to MCP tool errors with the same code as REST;
 *  - record an agent_tool_call trace event per call (redacted);
 *  - stateless Streamable HTTP transport (web-standard Request/Response).
 * Scope violations, expired tokens and revoked connections must behave like REST.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  void request;
  return Response.json(
    { code: 'not_implemented', message: 'The MCP endpoint is not available yet.', retryable: false, request_id: crypto.randomUUID() },
    { status: 501 },
  );
}
