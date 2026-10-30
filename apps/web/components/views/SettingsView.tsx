'use client';

import Link from 'next/link';
import { useCallback, useId, useState } from 'react';
import type { Scope } from '@culture-atlas/domain';
import type {
  AgentConnectionDto,
  CollectionSummary,
  CreateAgentConnectionResponse,
  CreateSensorConnectionResponse,
  SensorConnectionDto,
} from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { formatDate, hostOf, relativeTime, SCOPE_LABELS } from '@/lib/client/format';
import { useSession } from '@/lib/client/session';
import { broadcastSessionSignOut } from '@/lib/client/session-sync';
import { AccountPrompt } from '../AccountPrompt';
import { Dialog } from '../Dialog';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { Disclosure, Notice } from '../ui';
import { DevicesEntry } from '../v2/DevicesEntry';
import { defaultUploadStore, type UploadEntry } from '../v2/upload-store';

const READ_SCOPES: Scope[] = ['collections:read', 'plans:read', 'taste:read', 'captures:read'];
const WRITE_SCOPES: Scope[] = ['collections:write', 'plans:write', 'taste:write', 'captures:write'];
/** A sensor import older than this (with polling every 10 s) reads as offline. */
const SENSOR_STALE_MS = 5 * 60 * 1000;

export function sensorStatus(
  c: SensorConnectionDto,
  now = Date.now(),
): { label: string; offline: boolean } {
  if (!c.enabled) return { label: 'Import is off', offline: false };
  const last = c.last_success_at ? Date.parse(c.last_success_at) : null;
  const attempt = c.last_attempt_at ? Date.parse(c.last_attempt_at) : null;
  const failing = Boolean(c.last_error_code) && (!last || (attempt !== null && attempt > last));
  const stale = last !== null && now - last > SENSOR_STALE_MS;
  if (failing || stale || (!last && attempt !== null)) {
    return {
      label: last
        ? `Offline · last import ${relativeTime(c.last_success_at, now)}`
        : 'Offline · no photos imported yet',
      offline: true,
    };
  }
  if (!last) return { label: 'Waiting for the first import', offline: false };
  return {
    label: `Connected · last import ${relativeTime(c.last_success_at, now)}`,
    offline: false,
  };
}

export function accessSummary(
  c: Pick<AgentConnectionDto, 'library_access' | 'collection_ids'>,
  names: Map<string, string>,
): string {
  if (c.library_access === 'all') return 'Whole library';
  if (c.library_access === 'none') return 'No library access';
  const list = c.collection_ids.map((id) => names.get(id) ?? 'A collection');
  return list.join(', ');
}

/**
 * Local upload drafts of this account that still hold their bytes on this
 * device (not yet committed by the server). SCREEN-CONTRACT Upload rule:
 * sign-out with pending local media offers Keep on this device or Delete local drafts.
 */
export function pendingLocalDrafts(entries: readonly UploadEntry[], accountId: string | null): UploadEntry[] {
  if (!accountId) return [];
  return entries.filter((e) => e.account_id === accountId && e.blob !== null && e.phase !== 'ready');
}

/** Signed-in account: sign out (the next visit starts a fresh private session). */
export function AccountSection() {
  const { session } = useSession();
  const accountId = session?.principal.account_id ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<UploadEntry[] | null>(null);
  const finishSignOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request('signOut', { body: {} });
      await api.refreshSession();
      // Revoke the account's private surfaces in every other tab of this
      // browser before leaving: they reload and re-check the session instead
      // of keeping (or late-applying) this account's Taste/feed/photos.
      broadcastSessionSignOut();
      window.location.assign('/?signed_out=1');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    let pending: UploadEntry[] = [];
    try {
      pending = pendingLocalDrafts(await defaultUploadStore().all(), accountId);
    } catch {
      // Local storage unavailable: nothing can be kept or deleted here.
    }
    if (pending.length) {
      setBusy(false);
      setDrafts(pending);
    } else await finishSignOut();
  };
  const deleteDrafts = async () => {
    setBusy(true);
    try {
      const store = defaultUploadStore();
      for (const d of drafts ?? []) await store.delete(d.client_capture_id);
    } catch {
      setError('The local drafts could not be deleted. Try again.');
      setBusy(false);
      return;
    }
    await finishSignOut();
  };
  return (
    <section className="settings__section" id="account" aria-labelledby="settings-account">
      <h2 id="settings-account" className="section-title section-title--display">
        Your account
      </h2>
      <div className="settings__account">
        <p>You’re signed in. Your collections and plans are private to you.</p>
        <button type="button" className="button button--outline" onClick={() => void signOut()} disabled={busy}>
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
      <div className="settings__account-links">
        {/* First-party deletion entry (VAL-DELETE-001): a page that explains
            what deletion removes before it asks to confirm. */}
        <Link href="/settings/deletion" className="settings__deletion-link">
          Delete account…
        </Link>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Dialog
        open={drafts !== null}
        onClose={() => (busy ? undefined : setDrafts(null))}
        title="Some files have not finished uploading"
        variant="dialog"
        size="small"
      >
        <p>
          {drafts?.length === 1 ? '1 file is' : `${drafts?.length ?? 0} files are`} still only on this
          device. Keep them here to finish uploading after you sign in again, or delete the local
          drafts. Nothing already in your library changes.
        </p>
        <div className="form-actions">
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void finishSignOut()}>
            Keep on this device
          </button>
          <button type="button" className="button button--danger" disabled={busy} onClick={() => void deleteDrafts()}>
            Delete local drafts
          </button>
          <button type="button" className="button button--outline" disabled={busy} onClick={() => setDrafts(null)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </section>
  );
}

/** Account settings: agent connections (scoped, revocable) and World Sensor import status. */
export function SettingsView() {
  const { session, isAccount } = useSession();
  return (
    <div className="page page--narrow settings">
      <h1 className="display">Settings</h1>
      {!session ? (
        // Same footprint as the account section, so nothing jumps when the session lands.
        <div className="settings-skeleton" aria-busy="true">
          <div className="skeleton skeleton--line" style={{ width: 220, height: 30 }} />
          <div className="skeleton" style={{ height: 120 }} />
          <div className="skeleton skeleton--line" style={{ width: 160, height: 30 }} />
          <div className="skeleton" style={{ height: 80 }} />
          <p className="visually-hidden" role="status">
            Loading your settings…
          </p>
        </div>
      ) : !isAccount ? (
        <section className="settings__section" id="account">
          <h2 className="section-title section-title--display">Sign in or create an account</h2>
          {/* The one sign-in path everywhere (header, Library, Capture): an email link. */}
          <div className="settings__signin">
            <p>
              Sign in with a link sent to your email. It keeps your library, uploads and devices in
              sync.
            </p>
            <Link href="/identity" className="button button--primary">
              Sign in with email
            </Link>
          </div>
          <p className="muted settings__or">Or use a password on this browser:</p>
          <AccountPrompt
            lead="Create an account to keep saves, build collections and connect an agent."
            onCreated={() => undefined}
          />
        </section>
      ) : (
        <>
          <AccountSection />
          <TasteEntry />
          <DevicesEntry />
          <AgentConnections />
          <SensorConnections />
          <section className="settings__section">
            <h2 className="section-title section-title--display">Privacy</h2>
            <p>
              Your collections are private. Deleted photos and their discoveries are removed within
              24 hours, and encrypted backups expire within 30 days.
            </p>
            <p className="muted">
              Photos you submit are analyzed by AI services to find related discoveries. They are
              not used for training.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

/** Settings → Taste (spec amendment 2.2, screen 18). */
function TasteEntry() {
  return (
    <section className="settings__section" aria-labelledby="taste-heading">
      <h2 id="taste-heading" className="section-title section-title--display">
        Interests
      </h2>
      <p className="muted">What you picked when you joined, and foods to leave out.</p>
      <p style={{ marginTop: 12 }}>
        <Link href="/settings/taste" className="button button--outline">
          Edit your interests
          <Icon name="chevronRight" size={18} />
        </Link>
      </p>
    </section>
  );
}

function AgentConnections() {
  const toast = useToast();
  const [connections, setConnections] = useState<AgentConnectionDto[] | null>(null);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateAgentConnectionResponse | null>(null);
  const [revoking, setRevoking] = useState<AgentConnectionDto | null>(null);

  const load = useCallback(async () => {
    try {
      const [conns, cols] = await Promise.all([
        api.request('listAgentConnections', {}),
        api.request('listCollections', {}).catch(() => null),
      ]);
      setConnections(conns.connections);
      if (cols) setCollections(cols.collections);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Connections could not be loaded.');
    }
  }, []);
  useAsyncEffect(load, [load]);

  const names = new Map(collections.map((c) => [c.id, c.name]));
  const active = (connections ?? []).filter((c) => !c.revoked_at);

  return (
    <section className="settings__section" aria-labelledby="agents-heading">
      <h2 id="agents-heading" className="section-title section-title--display">
        Agent connections
      </h2>
      <p>
        Let a personal agent use culture atlas for you. You choose what it can see and change, and
        you can revoke it at any time.
      </p>
      {error && (
        <Notice tone="error" onRetry={() => void load()}>
          {error}
        </Notice>
      )}
      {connections && active.length === 0 && <p className="muted">No agents are connected.</p>}
      {active.length > 0 && (
        <ul className="connection-list">
          {active.map((c) => (
            <li key={c.id} className="connection">
              <div className="connection__main">
                <h3 className="connection__name">{c.client_name}</h3>
                <p className="connection__meta">Access: {accessSummary(c, names)}</p>
                <p className="connection__meta">
                  Can: {c.scopes.map((s) => SCOPE_LABELS[s].toLowerCase()).join('; ')}
                </p>
                <p className="connection__meta muted">
                  Expires {formatDate(c.expires_at)} ·{' '}
                  {c.last_used_at ? `last used ${relativeTime(c.last_used_at)}` : 'not used yet'} ·
                  credential {c.credential_prefix}…
                </p>
              </div>
              <button
                type="button"
                className="button button--outline button--small"
                onClick={() => setRevoking(c)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <Disclosure label="Connect an agent">
        <AgentForm
          collections={collections}
          onCreated={(res) => {
            setCreated(res);
            void load();
          }}
        />
      </Disclosure>

      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Agent connected"
        variant="dialog"
      >
        {created && (
          <CredentialOnce
            label="Connection credential"
            value={created.credential}
            extra={created.mcp_url}
          />
        )}
      </Dialog>
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.client_name ?? 'this agent'}?`}
        variant="dialog"
        size="small"
      >
        <p>It loses access immediately, including to plans made from your collections.</p>
        <div className="form-actions">
          <button
            type="button"
            className="button button--danger"
            onClick={async () => {
              if (!revoking) return;
              try {
                await api.request('revokeAgentConnection', {
                  params: { id: revoking.id },
                  idempotencyKey: newIdempotencyKey(),
                });
                toast.show({ message: `${revoking.client_name} was revoked` });
                setRevoking(null);
                void load();
              } catch (err) {
                toast.show({
                  message: err instanceof ApiError ? err.message : 'That didn’t work.',
                });
              }
            }}
          >
            Revoke access
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setRevoking(null)}
            data-autofocus
          >
            Cancel
          </button>
        </div>
      </Dialog>
    </section>
  );
}

function AgentForm({
  collections,
  onCreated,
}: {
  collections: CollectionSummary[];
  onCreated: (res: CreateAgentConnectionResponse) => void;
}) {
  const nameId = useId();
  const accessName = useId();
  const expiryId = useId();
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'selected_collections' | 'all'>('selected_collections');
  const [chosen, setChosen] = useState<string[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([...READ_SCOPES]);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid =
    name.trim().length > 0 && scopes.length > 0 && (access === 'all' || chosen.length > 0);
  const toggleScope = (s: Scope) =>
    setScopes((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));

  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        setError(null);
        try {
          const res = await api.request('createAgentConnection', {
            body: {
              client_name: name.trim(),
              scopes,
              library_access: access,
              collection_ids: access === 'selected_collections' ? chosen : [],
              expires_in_days: days,
            },
            idempotencyKey: newIdempotencyKey(),
          });
          setName('');
          setChosen([]);
          setScopes([...READ_SCOPES]);
          onCreated(res);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'The agent could not be connected.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={nameId} className="field-label">
        Agent name
      </label>
      <input
        id={nameId}
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        placeholder="My assistant"
        required
      />

      <fieldset className="radio-list">
        <legend className="field-label">What it can see</legend>
        <label className="check-row">
          <input
            type="radio"
            name={accessName}
            checked={access === 'selected_collections'}
            onChange={() => setAccess('selected_collections')}
          />
          <span>Only collections I choose</span>
        </label>
        {access === 'selected_collections' && (
          <div className="nested">
            {collections.length === 0 && <p className="muted">Create a collection first.</p>}
            {collections.map((c) => (
              <label key={c.id} className="check-row">
                <input
                  type="checkbox"
                  checked={chosen.includes(c.id)}
                  onChange={(e) =>
                    setChosen((x) =>
                      e.target.checked ? [...x, c.id] : x.filter((y) => y !== c.id),
                    )
                  }
                />
                <span>{c.name}</span>
              </label>
            ))}
            <p className="field-help">
              It can’t see unfiled saves, other collections or your overall taste. New collections
              aren’t added automatically.
            </p>
          </div>
        )}
        <label className="check-row">
          <input
            type="radio"
            name={accessName}
            checked={access === 'all'}
            onChange={() => setAccess('all')}
          />
          <span>My whole library</span>
        </label>
      </fieldset>

      <fieldset className="radio-list">
        <legend className="field-label">What it can do</legend>
        {READ_SCOPES.map((s) => (
          <label key={s} className="check-row">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
            <span>{SCOPE_LABELS[s]}</span>
          </label>
        ))}
        <p className="field-help">Changes (off by default):</p>
        {WRITE_SCOPES.map((s) => (
          <label key={s} className="check-row">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
            <span>{SCOPE_LABELS[s]}</span>
          </label>
        ))}
      </fieldset>

      <label htmlFor={expiryId} className="field-label">
        Expires after
      </label>
      <select
        id={expiryId}
        className="input select"
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
      >
        <option value={7}>7 days</option>
        <option value={30}>30 days</option>
        <option value={90}>90 days</option>
      </select>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button button--primary" disabled={!valid || busy}>
        {busy ? 'Connecting…' : 'Connect agent'}
      </button>
    </form>
  );
}

function CredentialOnce({
  label,
  value,
  extra,
}: {
  label: string;
  value: string;
  extra?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="credential">
      <p>
        <strong>This is the only time it’s shown.</strong> Copy it into your agent’s settings now.
      </p>
      <p className="field-label">{label}</p>
      <div className="credential__row">
        <code className="credential__value">{value}</code>
        <button
          type="button"
          className="button button--outline button--small"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={16} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {extra && (
        <>
          <p className="field-label">MCP endpoint (bearer authentication)</p>
          <code className="credential__value">{extra}</code>
        </>
      )}
    </div>
  );
}

function SensorConnections() {
  const toast = useToast();
  const [connections, setConnections] = useState<SensorConnectionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateSensorConnectionResponse | null>(null);

  const load = useCallback(async () => {
    try {
      setConnections((await api.request('listSensorConnections', {})).connections);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'World Sensor status could not be loaded.');
    }
  }, []);
  useAsyncEffect(load, [load]);

  return (
    <section className="settings__section" aria-labelledby="sensor-heading">
      <h2 id="sensor-heading" className="section-title section-title--display">
        World Sensor
      </h2>
      <p>Import new photos from your glasses. Imported photos are not treated as likes.</p>
      {error && (
        <Notice tone="error" onRetry={() => void load()}>
          {error}
        </Notice>
      )}
      {connections && connections.length === 0 && (
        <p className="muted">Not connected. Upload and camera work without it.</p>
      )}
      {connections && connections.length > 0 && (
        <ul className="connection-list">
          {connections.map((c) => {
            const status = sensorStatus(c);
            return (
              <li key={c.id} className="connection">
                <div className="connection__main">
                  <h3 className="connection__name">{hostOf(c.origin)}</h3>
                  <p
                    className={`connection__meta${status.offline ? ' connection__meta--warn' : ''}`}
                  >
                    {status.label}
                  </p>
                  {status.offline && (
                    <p className="connection__meta muted">Upload and camera are still available.</p>
                  )}
                </div>
                <button
                  type="button"
                  className="button button--outline button--small"
                  onClick={async () => {
                    if (
                      !window.confirm('Disconnect World Sensor? Its saved credential is removed.')
                    )
                      return;
                    try {
                      await api.request('deleteSensorConnection', {
                        params: { id: c.id },
                        idempotencyKey: newIdempotencyKey(),
                      });
                      toast.show({ message: 'World Sensor disconnected' });
                      void load();
                    } catch (err) {
                      toast.show({
                        message: err instanceof ApiError ? err.message : 'That didn’t work.',
                      });
                    }
                  }}
                >
                  Disconnect
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Disclosure label="Connect a relay (operator setup)">
        <SensorForm
          onCreated={(res) => {
            setCreated(res);
            void load();
          }}
        />
      </Disclosure>
      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title="World Sensor connected"
        variant="dialog"
      >
        {created?.bridge_token ? (
          <CredentialOnce label="Bridge token" value={created.bridge_token} />
        ) : (
          <p>New photos will be imported while the relay is reachable.</p>
        )}
      </Dialog>
    </section>
  );
}

function SensorForm({ onCreated }: { onCreated: (res: CreateSensorConnectionResponse) => void }) {
  const originId = useId();
  const credId = useId();
  const modeName = useId();
  const [origin, setOrigin] = useState('');
  const [credential, setCredential] = useState('');
  const [mode, setMode] = useState<'poll' | 'bridge'>('bridge');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const res = await api.request('createSensorConnection', {
            body: { origin: origin.trim(), viewer_credential: credential, mode },
            idempotencyKey: newIdempotencyKey(),
          });
          setCredential('');
          onCreated(res);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : 'The relay could not be connected.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={originId} className="field-label">
        Relay address
      </label>
      <input
        id={originId}
        className="input"
        type="url"
        value={origin}
        onChange={(e) => setOrigin(e.target.value)}
        placeholder="https://relay.example"
        required
      />
      <p className="field-help">Only addresses your operator allowed can be used.</p>
      <label htmlFor={credId} className="field-label">
        Viewer credential
      </label>
      <input
        id={credId}
        className="input"
        type="password"
        autoComplete="off"
        value={credential}
        onChange={(e) => setCredential(e.target.value)}
        required
      />
      <fieldset className="radio-list">
        <legend className="field-label">How photos arrive</legend>
        <label className="check-row">
          <input
            type="radio"
            name={modeName}
            checked={mode === 'bridge'}
            onChange={() => setMode('bridge')}
          />
          <span>A bridge running next to the relay sends them</span>
        </label>
        <label className="check-row">
          <input
            type="radio"
            name={modeName}
            checked={mode === 'poll'}
            onChange={() => setMode('poll')}
          />
          <span>culture atlas checks the relay every 10 seconds</span>
        </label>
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="button button--primary"
        disabled={busy || !origin || !credential}
      >
        {busy ? 'Connecting…' : 'Connect relay'}
      </button>
    </form>
  );
}
