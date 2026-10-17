'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { Scope } from '@culture-atlas/domain';
import type { AgentConnectionDto, CollectionSummary } from '@culture-atlas/domain/schemas';
import { api, newIdempotencyKey } from '@/lib/client/api';
import { SCOPE_LABELS } from '@/lib/client/format';
import { useSession } from '@/lib/client/session';
import {
  activityLabel,
  consentSummary,
  COPY,
  dayTime,
  expiresIn,
  isCaptureActivity,
  lastUsed,
  SHORT_SCOPE_LABELS,
} from './agents-sharing-format';
import './agent-platform.css';

/**
 * Screens 10 (Agents, /settings/agents) and 11 (Agent permission,
 * /settings/agents/new and the OAuth consent page). Layout follows the HTML
 * mockups in specs/capture-platform-v2/design/index.html sections 10–11.
 */

export const DEFAULT_AGENT_SCOPES: Scope[] = ['setup:read', 'preferences:read'];

type Activity = { id: string; client_name: string; action: string; target_label?: string | null; created_at: string };
type Library = 'none' | 'selected_collections' | 'all';

const loadError = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

export function Crumb({ children }: { children: ReactNode }) {
  return <small className="as-crumb"><Link href="/">culture atlas</Link> / {children}</small>;
}

function SignedOut({ title, body }: { title: string; body: string }) {
  return (
    <div className="as-page">
      <section className="as-card">
        <Crumb><Link href="/settings">Settings</Link></Crumb>
        <h1>{title}</h1>
        <p className="as-muted">{body}</p>
        <Link className="as-button as-primary" href="/settings">Sign in</Link>
      </section>
    </div>
  );
}

/** One-time credential display. Copied is announced only after clipboard success. */
export function SecretOnce({ credential, mcpUrl, onDone, doneLabel = 'Done' }: {
  credential: string; mcpUrl?: string | null; onDone(): void; doneLabel?: string;
}) {
  const [status, setStatus] = useState('');
  const id = useId();
  return (
    <div>
      <h1 id={`${id}-title`}>Copy your agent credential</h1>
      <p>This credential is shown once. Store it in your agent’s private credential settings now. It is never shown again.</p>
      <label htmlFor={`${id}-secret`}>Agent credential</label>
      <textarea id={`${id}-secret`} readOnly rows={3} value={credential} spellCheck={false} autoComplete="off"
        onFocus={(e) => e.currentTarget.select()} />
      {mcpUrl && <p className="as-muted">MCP endpoint: <code>{mcpUrl}</code></p>}
      <div className="as-actions">
        <button type="button" className="as-primary" onClick={async () => {
          try {
            await navigator.clipboard.writeText(credential);
            setStatus('Copied');
          } catch {
            setStatus('Copy is not available here. Select the credential above and copy it.');
          }
        }}>Copy credential</button>
        <button type="button" onClick={onDone}>{doneLabel}</button>
      </div>
      <p role="status" aria-live="polite" className="as-muted">{status}</p>
    </div>
  );
}

function ConnectionCard({ connection, collectionNames, onChanged, onSecret }: {
  connection: AgentConnectionDto;
  collectionNames: Map<string, string>;
  onChanged(message: string): Promise<void>;
  onSecret(secret: string): void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'revoke' | 'rotate'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(connection.scopes);
  const [collections, setCollections] = useState<string[]>(connection.collection_ids);
  const headingId = useId();
  const resources = connection.library_access === 'all'
    ? 'Entire library'
    : connection.library_access === 'selected_collections'
      ? connection.collection_ids.map((c) => collectionNames.get(c) ?? 'A collection').join(', ')
      : 'None';

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError('');
    try {
      await onChanged(await action());
      setMode('view');
    } catch (err) {
      // On failure the connection stays shown as it is (still active).
      setError(loadError(err, 'Could not change access. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="as-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{connection.client_name}</h2>
      <span className="as-badge">Connected</span>
      <p>{connection.scopes.map((s) => SHORT_SCOPE_LABELS[s]).join(' · ')}</p>
      <p>Collections: {resources}</p>
      {(connection.installation_ids?.length ?? 0) > 0 && (
        <p>Phones: {connection.installation_ids?.length} selected · capture only while allowed on the phone</p>
      )}
      <p className="as-muted">{expiresIn(connection.expires_at)} · {lastUsed(connection.last_used_at)}</p>
      {mode === 'view' && (
        <>
          <button type="button" onClick={() => setMode('edit')}>Edit permissions</button>{' '}
          <button type="button" onClick={() => setMode('revoke')}>Revoke access</button>
        </>
      )}
      {mode === 'revoke' && (
        <div role="group" aria-label={`Revoke ${connection.client_name}`}>
          <p><strong>Revoke access for {connection.client_name}?</strong> It stops working immediately. Anything it already downloaded cannot be recalled.</p>
          <div className="as-actions">
            <button type="button" className="as-danger" disabled={busy} onClick={() => run(async () => {
              await api.request('revokeConnectionV2', { params: { id: connection.id }, idempotencyKey: newIdempotencyKey() });
              return `Access revoked for ${connection.client_name}.`;
            })}>{busy ? 'Revoking…' : 'Revoke access'}</button>
            <button type="button" disabled={busy} onClick={() => setMode('view')}>Cancel</button>
          </div>
        </div>
      )}
      {mode === 'edit' && (
        <form onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api.request('narrowConnectionV2', {
              params: { id: connection.id },
              body: { scopes, ...(connection.library_access === 'selected_collections' ? { collection_ids: collections } : {}) },
              idempotencyKey: newIdempotencyKey(),
            });
            return `Permissions updated for ${connection.client_name}.`;
          });
        }}>
          <fieldset>
            <legend>Keep these permissions</legend>
            {connection.scopes.map((s) => (
              <label key={s}>
                <input type="checkbox" checked={scopes.includes(s)}
                  onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((v) => v !== s))} />
                {' '}{SCOPE_LABELS[s]}
              </label>
            ))}
          </fieldset>
          {connection.library_access === 'selected_collections' && (
            <fieldset>
              <legend>Keep these collections</legend>
              {connection.collection_ids.map((c) => (
                <label key={c}>
                  <input type="checkbox" checked={collections.includes(c)}
                    onChange={(e) => setCollections(e.target.checked ? [...collections, c] : collections.filter((v) => v !== c))} />
                  {' '}{collectionNames.get(c) ?? 'A collection'}
                </label>
              ))}
            </fieldset>
          )}
          <p className="as-muted">You can only remove access here. Wider access needs a new connection you approve.</p>
          <div className="as-actions">
            <button type="submit" className="as-primary" disabled={busy || scopes.length === 0}>Save permissions</button>
            <button type="button" disabled={busy} onClick={() => setMode('rotate')}>Rotate credential</button>
            <button type="button" disabled={busy} onClick={() => setMode('view')}>Cancel</button>
          </div>
          {scopes.length === 0 && <p className="as-muted">Keep at least one permission, or revoke access instead.</p>}
        </form>
      )}
      {mode === 'rotate' && (
        <div role="group" aria-label={`Rotate ${connection.client_name}`}>
          <p><strong>Replace the credential for {connection.client_name}?</strong> The current credential stops working immediately. The new one is shown once.</p>
          <div className="as-actions">
            <button type="button" className="as-primary" disabled={busy} onClick={() => run(async () => {
              const result = await api.request('rotateConnectionV2', { params: { id: connection.id } });
              onSecret(result.credential);
              return 'Credential replaced. The previous credential no longer works.';
            })}>{busy ? 'Replacing…' : 'Rotate credential'}</button>
            <button type="button" disabled={busy} onClick={() => setMode('edit')}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="as-alert">{error}</p>}
    </article>
  );
}

const fetchAgents = () => Promise.all([
  api.request('listConnectionsV2', {}),
  api.request('agentActivity', {}),
  api.request('listCollections', {}).catch(() => ({ collections: [] as CollectionSummary[] })),
]);

/** Screen 10: Connected agents. */
export function AgentPlatformView() {
  const { isAccount, session } = useSession();
  const [connections, setConnections] = useState<AgentConnectionDto[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [secret, setSecret] = useState<string | null>(null);

  function apply([list, events, cols]: Awaited<ReturnType<typeof fetchAgents>>) {
    setConnections(list.connections.filter((c) => c.status === 'active'));
    setActivity(events.items);
    setNames(new Map(cols.collections.map((c) => [c.id, c.name])));
    setError('');
  }
  async function reload() {
    try {
      apply(await fetchAgents());
    } catch (err) {
      setError(loadError(err, 'Could not load your agents.'));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!isAccount) return;
    let cancelled = false;
    fetchAgents().then((r) => { if (!cancelled) apply(r); },
      (err: unknown) => { if (!cancelled) setError(loadError(err, 'Could not load your agents.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isAccount]);

  if (session && !isAccount) {
    return <SignedOut title={COPY.agentsTitle} body="Sign in to connect and manage your own agents. Each agent acts only for your account." />;
  }
  if (secret) {
    return (
      <div className="as-page">
        <section className="as-card">
          <Crumb><Link href="/settings">Settings</Link> / <Link href="/settings/agents">Agents</Link></Crumb>
          <SecretOnce credential={secret} onDone={() => setSecret(null)} />
        </section>
      </div>
    );
  }
  const multiple = new Set(activity.map((a) => a.client_name)).size > 1;
  return (
    <div className="as-page">
      <section className="as-card" aria-labelledby="agents-title">
        <Crumb><Link href="/settings">Settings</Link></Crumb>
        <h1 id="agents-title">{COPY.agentsTitle}</h1>
        <p className="as-muted">{COPY.agentsSubtitle}</p>
        <Link className="as-button as-primary" href="/settings/agents/new">Connect agent</Link>
        <p role="status" aria-live="polite" className={status ? undefined : 'visually-hidden'}>{loading ? 'Loading agents…' : status}</p>
        {error && (
          <div role="alert">
            <p className="as-alert">{error}</p>
            <button type="button" onClick={() => { setLoading(true); void reload(); }}>Try again</button>
          </div>
        )}
        <div className="as-grid">
          <div className="as-stack" aria-label="Connections" role="region">
            {!loading && !error && connections.length === 0 && (
              <div className="as-panel">
                <h2>No agents connected</h2>
                <p className="as-muted">Your setup, preferences and library stay private until you connect an agent.</p>
              </div>
            )}
            {loading && <div className="as-panel" aria-hidden="true"><h2>Loading…</h2></div>}
            {connections.map((c) => (
              <ConnectionCard key={`${c.id}:${c.authorization_version}`} connection={c} collectionNames={names}
                onSecret={setSecret}
                onChanged={async (message) => { setStatus(message); await reload(); }} />
            ))}
          </div>
          <div className="as-panel">
            <h2>Your activity</h2>
            {/* The API pages newest first; the panel reads in time order, like the mockup. */}
            {activity.slice(0, 12).reverse().map((a) => (
              <p key={a.id}>
                {multiple ? `${a.client_name}: ` : <span className="visually-hidden">{a.client_name}: </span>}
                {activityLabel(a.action, a.target_label)} <small><time dateTime={a.created_at}>{dayTime(a.created_at)}</time></small>
              </p>
            ))}
            {!loading && activity.length === 0 && <p>No agent activity yet</p>}
            {!loading && !activity.some((a) => isCaptureActivity(a.action)) && <p>No capture requests</p>}
          </div>
        </div>
      </section>
    </div>
  );
}

type OAuthRequest = { client_id: string; redirect_uri: string; state: string; code_challenge: string; resource: string };
type Device = { id: string; platform: string; app_version: string; alias?: string };

/** Screen 11: Connect an agent (personal credential) or OAuth consent. */
export function ConnectAgentView({ oauth }: { oauth?: OAuthRequest }) {
  const { isAccount, session } = useSession();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_AGENT_SCOPES);
  const [library, setLibrary] = useState<Exclude<Library, 'none'>>('selected_collections');
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [installations, setInstallations] = useState<string[]>([]);
  const [days, setDays] = useState(30);
  const [created, setCreated] = useState<{ credential: string; mcp_url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ids = useId();

  useEffect(() => {
    if (!isAccount) return;
    void api.request('listCollections', {}).then((r) => setCollections(r.collections))
      .catch(() => setError('Could not load your collections. Refresh to try again.'));
    void fetch('/v2/devices', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (r) => { if (r.ok) setDevices(((await r.json()) as { items?: Device[] }).items ?? []); })
      .catch(() => undefined);
  }, [isAccount]);

  if (session && !isAccount) {
    return <SignedOut title={oauth ? 'Authorize an agent app' : 'Connect an agent'} body="Sign in before reviewing agent permissions. Only you can connect agents to your account." />;
  }
  if (created) {
    return (
      <div className="as-page">
        <section className="as-card">
          <Crumb><Link href="/settings">Settings</Link> / <Link href="/settings/agents">Agents</Link></Crumb>
          <SecretOnce credential={created.credential} mcpUrl={created.mcp_url} doneLabel="Back to connected agents"
            onDone={() => { setCreated(null); window.location.assign('/settings/agents'); }} />
        </section>
      </div>
    );
  }

  const has = (s: Scope) => scopes.includes(s);
  const toggle = (s: Scope | Scope[], on: boolean) => {
    const list = Array.isArray(s) ? s : [s];
    setScopes(on ? [...new Set([...scopes, ...list])] : scopes.filter((v) => !list.includes(v)));
  };
  const viewsCollections = has('collections:read');
  const libraryAccess: Library = viewsCollections ? library : 'none';
  const mediaScopes: Scope[] = ['media:read', 'media:download', 'media:analyze', 'media:write', 'collections:write'];
  const finalScopes = viewsCollections ? scopes : scopes.filter((s) => !mediaScopes.includes(s));
  const missingCollections = viewsCollections && library === 'selected_collections' && selected.length === 0;
  const missingPhones = has('devices:command') && installations.length === 0;
  const verb = (label: string, scope: Scope, extra?: ReactNode) => (
    <label>
      <input type="checkbox" checked={has(scope)} onChange={(e) => toggle(scope, e.target.checked)} />
      {' '}{label}{extra}
    </label>
  );

  return (
    <div className="as-page">
      <section className="as-card" aria-labelledby={`${ids}-title`}>
        <Crumb><Link href="/settings">Settings</Link> / <Link href="/settings/agents">Agents</Link></Crumb>
        <h1 id={`${ids}-title`}>{oauth ? 'Authorize an agent app' : 'Connect an agent'}</h1>
        <form onSubmit={async (event) => {
          event.preventDefault();
          if (missingCollections || missingPhones || !name.trim()) return;
          setBusy(true);
          setError('');
          const grant = {
            client_name: name.trim(), scopes: finalScopes, library_access: libraryAccess,
            collection_ids: libraryAccess === 'selected_collections' ? selected : [],
            installation_ids: has('devices:command') ? installations : [], expires_in_days: days,
          };
          try {
            if (oauth) {
              const result = await api.request('oauthConsent', { body: { ...oauth, code_challenge_method: 'S256', grant } });
              window.location.assign(result.redirect_uri);
            } else {
              const result = await api.request('createConnectionV2', { body: grant, idempotencyKey: newIdempotencyKey() });
              setCreated({ credential: result.credential, mcp_url: result.mcp_url });
            }
          } catch (err) {
            setError(loadError(err, 'Could not connect the agent. Try again.'));
          } finally {
            setBusy(false);
          }
        }}>
          <div className="as-grid">
            <div>
              <label>Agent name<br />
                <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              </label>
              {oauth && <p className="as-muted">The app’s registered name identifies this connection.</p>}
              <h2>What it can do</h2>
              {verb('View my device setup', 'setup:read')}
              {verb('Read my preferences', 'preferences:read')}
              {verb('Change ordinary preferences', 'preferences:write')}
              {verb('View selected collections', 'collections:read')}
              {viewsCollections && (
                <fieldset>
                  <legend>Collections it can view</legend>
                  <label>Library access<br />
                    <select value={library} onChange={(e) => setLibrary(e.target.value as typeof library)}>
                      <option value="selected_collections">Selected collections</option>
                      <option value="all">Entire library</option>
                    </select>
                  </label>
                  {library === 'selected_collections' && (collections.length ? collections.map((c) => (
                    <label key={c.id}>
                      <input type="checkbox" checked={selected.includes(c.id)}
                        onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((v) => v !== c.id))} />
                      {' '}{c.name}
                    </label>
                  )) : <p className="as-muted">You have no collections yet.</p>)}
                  <p className="as-muted">Items you add to these collections later become visible. New collections are never included automatically.</p>
                  {mediaScopes.filter((s) => s !== 'collections:write').map((s) => (
                    <label key={s}><input type="checkbox" checked={has(s)} onChange={(e) => toggle(s, e.target.checked)} />{' '}{SCOPE_LABELS[s]}</label>
                  ))}
                  <label><input type="checkbox" checked={has('collections:write')} onChange={(e) => toggle('collections:write', e.target.checked)} />{' '}{SCOPE_LABELS['collections:write']}</label>
                  {has('media:download') && <p className="as-muted">Original downloads are recorded in your activity.</p>}
                </fieldset>
              )}
              {verb(COPY.agentsRemote, 'devices:command')}
              {has('devices:command') && (
                <fieldset>
                  <legend>Phones it can ask</legend>
                  {devices.length ? devices.map((d) => (
                    <label key={d.id}>
                      <input type="checkbox" checked={installations.includes(d.id)}
                        onChange={(e) => setInstallations(e.target.checked ? [...installations, d.id] : installations.filter((v) => v !== d.id))} />
                      {' '}{d.alias ?? `${d.platform === 'ios' ? 'iPhone' : 'Android phone'} · app ${d.app_version}`}
                    </label>
                  )) : <p className="as-muted">No phones are registered. Install the culture atlas app and sign in on your phone first.</p>}
                </fieldset>
              )}
              <p className="as-muted">{COPY.agentsRemoteNotice}</p>
              <details>
                <summary>Technical details</summary>
                <p className="as-muted">Scopes: {finalScopes.map((s) => <code key={s}>{s} </code>)}</p>
                <p className="as-muted">Library access: <code>{libraryAccess}</code></p>
              </details>
            </div>
            <div className="as-panel">
              <h2>Access summary</h2>
              {consentSummary(finalScopes, libraryAccess, selected.length).map((line) => <p key={line}>{line}</p>)}
              <label>Expires after{' '}
                <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  <option value={30}>30 days</option>
                  <option value={7}>7 days</option>
                  <option value={90}>90 days</option>
                </select>
              </label>
              <button type="submit" className="as-primary" disabled={busy || finalScopes.length === 0 || missingCollections || missingPhones}>
                {busy ? 'Connecting…' : oauth ? 'Authorize agent' : 'Connect agent'}
              </button>
              {missingCollections && <p className="as-muted">Choose at least one collection.</p>}
              {missingPhones && <p className="as-muted">Choose the phone this agent may ask.</p>}
              <p className="as-muted">{oauth
                ? 'You return to the app after approving. You can revoke it at any time.'
                : 'Your credential will be shown once. You can revoke it at any time.'}</p>
              {error && <p role="alert" className="as-alert">{error}</p>}
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
