import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { ConnectionRefusedError, connectMcp } from './client';
import { DemoError, runDemo } from './demo';

/**
 * Independent demo agent. Talks to culture atlas ONLY through the public MCP
 * endpoint with a bearer connection token. It never imports the domain
 * packages or touches the database.
 *
 *   DEMO_AGENT_TOKEN=cat_... pnpm demo-agent -- --url http://localhost:3000/mcp --collection "Tokyo evenings"
 *
 * Environment: DEMO_AGENT_MCP_URL, DEMO_AGENT_TOKEN, DEMO_AGENT_COLLECTION,
 * DEMO_AGENT_INSTRUCTION, and optionally FEATHERLESS_API_KEY (or ANTHROPIC_API_KEY)
 * + DEMO_AGENT_MODEL so the agent's own model writes the film-replacement instruction.
 */

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : undefined;
};

const { values } = parseArgs({
  // `pnpm demo-agent -- --url ...` forwards a literal "--"; drop it.
  args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    collection: { type: 'string' },
    instruction: { type: 'string' },
    'list-tools': { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const url = values.url ?? env('DEMO_AGENT_MCP_URL') ?? 'http://localhost:3000/mcp';
const token = values.token ?? env('DEMO_AGENT_TOKEN');

function redactToken(t: string): string {
  const m = /^(cat_[a-z0-9]+)_/.exec(t);
  return m ? `${m[1]}_…` : '[token]';
}

function instructionPrompt(plan: { film: string; title: string | null }): string {
  return (
    `You are a personal agent helping plan a movie night titled ${JSON.stringify(plan.title ?? 'Movie night')}. ` +
    `The current film is ${JSON.stringify(plan.film)}. Write one short instruction (under 25 words) asking for a ` +
    'replacement film that keeps the same mood but feels fresher. Reply with the instruction only.'
  );
}

/** Featherless serves an OpenAI-compatible Chat Completions API. */
async function featherlessInstruction(plan: { film: string; title: string | null }): Promise<string> {
  const base = (env('FEATHERLESS_BASE_URL') ?? 'https://api.featherless.ai/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('FEATHERLESS_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env('DEMO_AGENT_MODEL') ?? 'google/gemma-3-27b-it',
      max_tokens: 120,
      messages: [{ role: 'user', content: instructionPrompt(plan) }],
    }),
  });
  if (!res.ok) throw new Error(`featherless API error ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const text = (json.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('empty model reply');
  return text;
}

async function anthropicInstruction(plan: { film: string; title: string | null }): Promise<string> {
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') });
  const res = await client.messages.create({
    model: env('DEMO_AGENT_MODEL') ?? 'claude-sonnet-5-5',
    max_tokens: 120,
    messages: [{ role: 'user', content: instructionPrompt(plan) }],
  });
  const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
  if (!text) throw new Error('empty model reply');
  return text;
}

const modelInstruction = env('FEATHERLESS_API_KEY') ? featherlessInstruction : env('ANTHROPIC_API_KEY') ? anthropicInstruction : undefined;

async function main(): Promise<number> {
  if (!token) {
    console.error('Set DEMO_AGENT_TOKEN (or --token) to an agent connection credential created in culture atlas settings.');
    return 2;
  }
  console.log(`[demo-agent] connecting to ${url} with ${redactToken(token)}`);
  const caller = await connectMcp({ url, token });
  try {
    if (values['list-tools']) {
      console.log((await caller.listTools()).join('\n'));
      return 0;
    }
    await runDemo(caller, {
      collectionName: values.collection ?? env('DEMO_AGENT_COLLECTION'),
      instruction: values.instruction ?? env('DEMO_AGENT_INSTRUCTION'),
      chooseInstruction: modelInstruction,
    });
    return 0;
  } finally {
    await caller.close().catch(() => undefined);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ConnectionRefusedError) {
      console.error(`[demo-agent] connection refused (${err.status} ${err.code}): ${err.message}`);
    } else if (err instanceof DemoError) {
      console.error(`[demo-agent] ${err.message}`);
    } else {
      console.error('[demo-agent] failed:', (err as Error).message);
    }
    process.exitCode = 1;
  });
