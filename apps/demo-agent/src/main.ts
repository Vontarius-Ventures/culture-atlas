/**
 * Independent demo agent. Talks to culture atlas ONLY through the public MCP
 * endpoint (DEMO_AGENT_MCP_URL) with a bearer connection token
 * (DEMO_AGENT_TOKEN). It must not import @culture-atlas/domain or touch the DB.
 * TODO(agent owner): with @modelcontextprotocol/sdk Client + Streamable HTTP:
 *  list_collections -> get_collection (granted) -> discover_related -> get_job
 *  -> create_plan -> get_job -> get_plan -> replace_plan_section(film) -> get_job
 *  -> get_plan; print each call. Optionally use Anthropic (DEMO_AGENT_MODEL) to
 *  choose a replacement instruction. Also demonstrate that an ungranted
 *  collection and global get_taste are refused.
 */
const url = process.env.DEMO_AGENT_MCP_URL ?? 'http://localhost:3000/mcp';
console.log(`[demo-agent] would connect to ${url}; not implemented yet.`);
process.exitCode = 1;
