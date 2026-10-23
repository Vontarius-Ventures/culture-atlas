import { ConnectAgentView } from '@/components/views/AgentPlatformView';
export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const fields = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'resource'] as const;
  if (query.response_type !== 'code' || query.code_challenge_method !== 'S256' || fields.some((k) => typeof query[k] !== 'string')) {
    return <div className="page"><h1>Cannot authorize this app</h1><p>Ask the app to start a new authorization request with PKCE S256.</p></div>;
  }
  const oauth = Object.fromEntries(fields.map((k) => [k, query[k]])) as Record<typeof fields[number], string>;
  return <ConnectAgentView oauth={oauth} />;
}
