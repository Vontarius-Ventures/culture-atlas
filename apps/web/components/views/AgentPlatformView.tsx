'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Scope } from '@culture-atlas/domain';
import type { AgentConnectionDto, CollectionSummary } from '@culture-atlas/domain/schemas';
import { api, newIdempotencyKey } from '@/lib/client/api';
import { SCOPE_LABELS, relativeTime } from '@/lib/client/format';
import { useSession } from '@/lib/client/session';
import './agent-platform.css';

export const DEFAULT_AGENT_SCOPES: Scope[] = ['setup:read', 'preferences:read'];
const SCOPES: Scope[] = ['setup:read', 'preferences:read', 'preferences:write', 'collections:read',
  'collections:write', 'media:read', 'media:download', 'media:write', 'media:analyze', 'plans:read', 'plans:write', 'devices:command'];

const fetchAgents = () => Promise.all([api.request('listConnectionsV2', {}), api.request('agentActivity', {})]);
const loadErrorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Could not load agents.');

function Secret({ value, dismiss }: { value: string; dismiss(): void }) {
  const [copied, setCopied] = useState(false);
  return <section className="agent-panel" aria-labelledby="secret-heading">
    <h2 id="secret-heading">Your credential, shown once</h2>
    <p>Save it in your agent’s private credential store. It will not be shown again.</p>
    <textarea readOnly aria-label="Agent credential" value={value} rows={3} spellCheck={false} autoComplete="off" />
    <div className="agent-actions">
      <button type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); }
        catch { setCopied(false); }
      }}>Copy credential</button>
      <button type="button" onClick={dismiss}>I have saved it</button>
    </div>
    <p role="status">{copied ? 'Copied' : 'You can also select the credential and copy it manually.'}</p>
  </section>;
}

export function AgentPlatformView() {
  const { isAccount } = useSession();
  const [connections, setConnections] = useState<AgentConnectionDto[]>([]);
  const [activity, setActivity] = useState<Array<{ id: string; client_name: string; action: string; created_at: string }>>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState<{ connection: AgentConnectionDto; action: 'revoke' | 'rotate' } | null>(null);
  const [editing, setEditing] = useState<AgentConnectionDto | null>(null);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  async function load() {
    try {
      const [list, events] = await fetchAgents();
      setConnections(list.connections); setActivity(events.items); setError('');
    } catch (err) { setError(loadErrorMessage(err)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (!isAccount) return;
    // Inline (not load()) so no state is set synchronously inside the effect,
    // and a late response after sign-out or unmount is ignored.
    let cancelled = false;
    fetchAgents()
      .then(([list, events]) => {
        if (cancelled) return;
        setConnections(list.connections); setActivity(events.items); setError('');
      }, (err: unknown) => { if (!cancelled) setError(loadErrorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isAccount]);
  if (!isAccount) return <div className="page agent-platform"><h1>Connected agents</h1><p>Sign in to connect and manage your own agents.</p><Link href="/settings">Account settings</Link></div>;
  return <div className="page agent-platform">
    <Link href="/settings">Settings</Link><h1>Connected agents</h1>
    <p>Choose what each agent can see and do.</p><Link className="button button--primary" href="/settings/agents/new">Connect agent</Link>
    {error && <div role="alert"><p>{error}</p><button onClick={() => void load()}>Retry</button></div>}
    <p role="status">{loading ? 'Loading agents…' : status}</p>
    {secret && <Secret value={secret} dismiss={() => setSecret(null)} />}
    <div className="agent-grid"><section aria-label="Connections">
      {!loading && !connections.length && <p>No agents connected. Your setup and library are private.</p>}
      {connections.map((c) => <article className="agent-panel" key={c.id}>
        <h2>{c.client_name}</h2><p>{c.status === 'active' ? 'Connected' : c.status}</p>
        <ul>{[...c.access_summary.reads, ...c.access_summary.writes].map((s) => <li key={s}>{s}</li>)}</ul>
        <p>Expires {new Date(c.expires_at).toLocaleDateString()} · Last used {relativeTime(c.last_used_at)}</p>
        {c.status === 'active' && <div className="agent-actions">
          <button onClick={() => setEditing(c)}>Edit permissions</button>
          <button onClick={() => setPending({ connection: c, action: 'rotate' })}>Rotate credential</button>
          <button onClick={() => setPending({ connection: c, action: 'revoke' })}>Revoke access</button>
        </div>}
      </article>)}
    </section><section className="agent-panel"><h2>Your activity</h2>
      {!activity.length ? <p>No agent activity yet.</p> : <ol>{activity.map((e) => <li key={e.id}>
        {e.client_name}: {e.action.replaceAll('.', ' ')} <time dateTime={e.created_at}>{relativeTime(e.created_at)}</time>
      </li>)}</ol>}
    </section></div>
    {pending && <section className="agent-panel" aria-labelledby="confirm-agent">
      <h2 id="confirm-agent">{pending.action === 'revoke' ? 'Revoke' : 'Rotate'} {pending.connection.client_name}?</h2>
      <p>{pending.action === 'revoke' ? 'This agent will immediately lose access.' : 'The previous credential will stop working immediately.'}</p>
      <button disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try {
          if (pending.action === 'rotate') {
            const result = await api.request('rotateConnectionV2', { params: { id: pending.connection.id } });
            setSecret(result.credential); setStatus('Credential rotated. The previous secret no longer works.');
          } else {
            await api.request('revokeConnectionV2', { params: { id: pending.connection.id }, idempotencyKey: newIdempotencyKey() });
            setSecret(null); setStatus(`Access revoked for ${pending.connection.client_name}.`);
          }
          setPending(null); await load();
        } catch (err) { setError(err instanceof Error ? err.message : 'Could not change access.'); }
        finally { setBusy(false); }
      }}>{busy ? 'Saving…' : `Confirm ${pending.action}`}</button>
      <button disabled={busy} onClick={() => setPending(null)}>Cancel</button>
    </section>}
    {editing && <section className="agent-panel"><h2>Edit {editing.client_name}</h2>
      <p>Remove permissions below. Wider access requires a new consent transaction.</p>
      {editing.scopes.map((s) => <label key={s}><input type="checkbox" defaultChecked name="narrow-scope" value={s} />{SCOPE_LABELS[s]}</label>)}
      <button onClick={async () => {
        const scopes = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="narrow-scope"]:checked')).map((e) => e.value as Scope);
        try {
          await api.request('narrowConnectionV2', { params: { id: editing.id }, body: { scopes }, idempotencyKey: newIdempotencyKey() });
          setEditing(null); setStatus('Permissions updated.'); await load();
        } catch (err) { setError(err instanceof Error ? err.message : 'Could not update permissions.'); }
      }}>Save narrower permissions</button><button onClick={() => setEditing(null)}>Cancel</button>
    </section>}
  </div>;
}

export function ConnectAgentView({ oauth }: { oauth?: { client_id: string; redirect_uri: string; state: string; code_challenge: string; resource: string } }) {
  const { isAccount } = useSession();
  const [name, setName] = useState(''), [scopes, setScopes] = useState<Scope[]>(DEFAULT_AGENT_SCOPES);
  const [library, setLibrary] = useState<'none' | 'selected_collections' | 'all'>('none');
  const [collections, setCollections] = useState<CollectionSummary[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [devices, setDevices] = useState<Array<{ id: string; platform: string; app_version: string }>>([]);
  const [installations, setInstallations] = useState<string[]>([]);
  const [days, setDays] = useState(30), [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!isAccount) return;
    void api.request('listCollections', {}).then((r) => setCollections(r.collections)).catch(() => setError('Could not load collections. Refresh to retry.'));
    void fetch('/v2/devices', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (r) => { if (r.ok) setDevices((await r.json()).items ?? []); }).catch(() => undefined);
  }, [isAccount]);
  if (!isAccount) return <div className="page agent-platform"><h1>Connect an agent</h1><p>Sign in before reviewing agent permissions.</p><Link href="/settings">Account settings</Link></div>;
  return <div className="page agent-platform"><Link href="/settings/agents">Connected agents</Link><h1>{oauth ? 'Authorize an agent app' : 'Connect an agent'}</h1>
    {secret ? <Secret value={secret} dismiss={() => { setSecret(null); window.location.assign('/settings/agents'); }} /> :
      <form onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setError('');
        const grant = { client_name: name, scopes, library_access: library, collection_ids: library === 'selected_collections' ? selected : [],
          installation_ids: installations, expires_in_days: days };
        try {
          if (oauth) {
            const result = await api.request('oauthConsent', { body: { ...oauth, code_challenge_method: 'S256', grant } });
            window.location.assign(result.redirect_uri);
          } else {
            const result = await api.request('createConnectionV2', { body: grant, idempotencyKey: newIdempotencyKey() });
            setSecret(result.credential);
          }
        } catch (err) { setError(err instanceof Error ? err.message : 'Could not connect. Try again.'); }
        finally { setBusy(false); }
      }}>
        <div className="agent-grid"><section>
          <label>Agent name<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
          {oauth && <p>The registered app name, not this label, will identify this OAuth connection.</p>}
          <fieldset><legend>What it can do</legend>{SCOPES.map((s) => <label key={s}>
            <input type="checkbox" checked={scopes.includes(s)} onChange={(e) =>
              setScopes(e.target.checked ? [...scopes, s] : scopes.filter((v) => v !== s))} />{SCOPE_LABELS[s]}
          </label>)}</fieldset>
          <p>Capture also requires permission on your phone. Microphone and remote arming stay off until you allow them locally.</p>
          <label>Library access<select value={library} onChange={(e) => setLibrary(e.target.value as typeof library)}>
            <option value="none">None</option><option value="selected_collections">Selected collections</option><option value="all">Entire library</option>
          </select></label>
          {library === 'selected_collections' && <fieldset><legend>Permitted collections</legend>{collections.map((c) => <label key={c.id}>
            <input type="checkbox" checked={selected.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))} />{c.name}
          </label>)}</fieldset>}
          {library === 'selected_collections' && <p>Newly added items in these collections become visible. New collections are never included automatically.</p>}
          {scopes.includes('devices:command') && <fieldset><legend>Selected phones</legend>{!devices.length && <p>No eligible phones. Register a phone before enabling capture requests.</p>}
            {devices.map((d) => <label key={d.id}><input type="checkbox" checked={installations.includes(d.id)} onChange={(e) =>
              setInstallations(e.target.checked ? [...installations, d.id] : installations.filter((id) => id !== d.id))} />{d.platform} · {d.app_version}</label>)}
          </fieldset>}
        </section><aside className="agent-panel"><h2>Access summary</h2>
          <ul>{scopes.map((s) => <li key={s}>{SCOPE_LABELS[s]}</li>)}</ul>
          {library === 'none' && <p>No media or collection access.</p>}
          {!scopes.includes('devices:command') && <p>No camera or microphone control.</p>}
          <label>Expires after<select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90].map((n) => <option key={n} value={n}>{n} days</option>)}</select></label>
          <button type="submit" className="button button--primary" disabled={busy}>{busy ? 'Connecting…' : oauth ? 'Authorize agent' : 'Connect agent'}</button>
          <p>{oauth ? 'You will return to the registered app after approval.' : 'Your credential will be shown once.'} You can revoke access at any time.</p>
        </aside></div>
      </form>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
