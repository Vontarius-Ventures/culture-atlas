'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { ShareDto } from '@culture-atlas/domain/schemas';
import { api, isApiError, newIdempotencyKey } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { COPY, expiresIn, shareStateTitle } from './agents-sharing-format';
import { Crumb } from './AgentPlatformView';
import './agent-platform.css';

/**
 * Screen 12: Collection share (/collections/:id/share). Restricted is the
 * default; link access needs an explicit policy confirmation; including
 * captured media previews exactly which items become visible; links are shown
 * only after a successful create and "Copied" only after clipboard success.
 */

type Preview = { id: string; kind: 'photo' | 'video'; title: string | null };
type Pending = { share: ShareDto; include_media: boolean; allow_originals: boolean; preview: Preview[]; broadening: string[] };

function CopyField({ label, value }: { label: string; value: string }) {
  const [status, setStatus] = useState('');
  const id = useId();
  return (
    <div className="as-field">
      <label htmlFor={id} style={{ margin: 0 }}>{label}</label>
      <input id={id} readOnly value={value} onFocus={(e) => e.currentTarget.select()} style={{ width: '100%' }} />
      <div className="as-actions">
        <button type="button" onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus('Copied');
          } catch {
            setStatus('Copy is not available here. Select the link above and copy it.');
          }
        }}>Copy link</button>
      </div>
      <p role="status" aria-live="polite" className="as-muted">{status}</p>
    </div>
  );
}

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

export function ShareCollectionView({ collectionId }: { collectionId: string }) {
  const { isAccount, session } = useSession();
  const [name, setName] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [audience, setAudience] = useState<'restricted' | 'link'>('restricted');
  const [email, setEmail] = useState('');
  const [includeMedia, setIncludeMedia] = useState(false);
  const [allowOriginals, setAllowOriginals] = useState(false);
  const [linkDays, setLinkDays] = useState<1 | 7 | 30>(7);
  const [confirmLink, setConfirmLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [revoking, setRevoking] = useState<ShareDto | null>(null);
  const ids = useId();

  const restricted = shares.find((s) => s.audience === 'restricted' && s.status === 'active') ?? null;
  const links = shares.filter((s) => s.audience === 'link' && s.status === 'active');

  async function load(initial = false) {
    try {
      const [detail, list] = await Promise.all([
        api.request('getCollection', { params: { id: collectionId }, query: { limit: 1 } }),
        api.request('listShares', { params: { id: collectionId } }),
      ]);
      setName(detail.collection.name);
      setShares(list.shares);
      const r = list.shares.find((s) => s.audience === 'restricted' && s.status === 'active');
      if (initial && r) {
        setIncludeMedia(r.include_media);
        setAllowOriginals(r.allow_originals);
      }
      setLoadError('');
    } catch (err) {
      setLoadError(isApiError(err, 'not_found') ? 'This collection was not found.' : errorText(err, 'Could not load sharing settings.'));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!isAccount) return;
    let cancelled = false;
    void Promise.all([
      api.request('getCollection', { params: { id: collectionId }, query: { limit: 1 } }),
      api.request('listShares', { params: { id: collectionId } }),
    ]).then(([detail, list]) => {
      if (cancelled) return;
      setName(detail.collection.name);
      setShares(list.shares);
      const r = list.shares.find((s) => s.audience === 'restricted' && s.status === 'active');
      if (r) {
        setIncludeMedia(r.include_media);
        setAllowOriginals(r.allow_originals);
      }
    }, (err: unknown) => {
      if (!cancelled) setLoadError(isApiError(err, 'not_found') ? 'This collection was not found.' : errorText(err, 'Could not load sharing settings.'));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isAccount, collectionId]);

  /** Apply media policy to a share; broadening goes through the preview confirmation. */
  async function applyPolicy(share: ShareDto, include: boolean, originals: boolean, confirm = false): Promise<boolean> {
    if (share.include_media === include && share.allow_originals === (include && originals)) return true;
    try {
      await api.request('updateShare', {
        params: { id: share.id },
        body: { include_media: include, allow_originals: include && originals, confirm_broaden: confirm },
        ifMatch: `"${share.policy_version}"`,
        idempotencyKey: newIdempotencyKey(),
      });
      return true;
    } catch (err) {
      const details = isApiError(err, 'conflict') ? (err.body.details as { confirmation_required?: boolean; would_include?: Preview[]; broadening?: string[] } | undefined) : undefined;
      if (details?.confirmation_required) {
        setPending({ share, include_media: include, allow_originals: originals, preview: details.would_include ?? [], broadening: details.broadening ?? [] });
        return false;
      }
      throw err;
    }
  }

  async function ensureRestricted(): Promise<ShareDto> {
    if (restricted) return restricted;
    const created = await api.request('createShare', {
      params: { id: collectionId }, body: { audience: 'restricted', include_media: false, allow_originals: false },
      idempotencyKey: newIdempotencyKey(),
    });
    setShares((s) => [created.share, ...s]);
    return created.share;
  }

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await run();
    } catch (err) {
      setError(errorText(err, 'Could not save sharing settings. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (session && !isAccount) {
    return (
      <div className="as-page"><section className="as-card">
        <Crumb><Link href="/collections">Collections</Link></Crumb>
        <h1>Share a collection</h1>
        <p className="as-muted">Sign in to share your collections.</p>
        <Link className="as-button as-primary" href="/settings">Sign in</Link>
      </section></div>
    );
  }
  if (loadError) {
    return (
      <div className="as-page"><section className="as-card">
        <Crumb><Link href="/collections">Collections</Link></Crumb>
        <h1>Share a collection</h1>
        <p role="alert" className="as-alert">{loadError}</p>
        <button type="button" onClick={() => { setLoading(true); void load(true); }}>Try again</button>
      </section></div>
    );
  }

  const members = restricted?.members.length ?? 0;
  const pendingInvites = restricted?.invitations.filter((i) => i.status === 'pending').length ?? 0;
  const title = shareStateTitle(links.length, members, pendingInvites, Boolean(restricted));

  return (
    <div className="as-page">
      <section className="as-card" aria-labelledby={`${ids}-title`} aria-busy={loading}>
        <Crumb><Link href="/collections">Collections</Link>{name && <> / <Link href={`/collections/${collectionId}`}>{name}</Link></>}</Crumb>
        <h1 id={`${ids}-title`}>{name ? `Share ${name}` : 'Share collection'}</h1>
        <div className="as-grid">
          <div>
            <label>Who can view
              <select aria-label="Who can view" value={audience} onChange={(e) => { setAudience(e.target.value as typeof audience); setShareLink(null); }}>
                <option value="restricted">{COPY.sharesRestricted}</option>
                <option value="link">{COPY.sharesLink}</option>
              </select>
            </label>
            {audience === 'restricted' ? (
              <form onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const share = await ensureRestricted();
                  const created = await api.request('createShareInvitation', {
                    params: { id: share.id }, body: { email }, idempotencyKey: newIdempotencyKey(),
                  });
                  setInviteLink(created.link);
                  setEmail('');
                  setStatus('Invitation link created. Send it to them yourself.');
                  await load();
                });
              }}>
                <label>Invite by verified email<br />
                  <input type="email" required placeholder="name@example.com" aria-label="Recipient email" value={email}
                    onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
                </label>
                <button type="submit" disabled={busy}>Create invitation link</button>
                {inviteLink && <CopyField label="Invitation link (expires in 7 days)" value={inviteLink} />}
              </form>
            ) : (
              <div>
                <p>{COPY.sharesNotice}</p>
                <label>Link expires after{' '}
                  <select value={linkDays} onChange={(e) => setLinkDays(Number(e.target.value) as 1 | 7 | 30)}>
                    <option value={1}>1 day</option>
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                  </select>
                </label>
                <label>
                  <input type="checkbox" checked={confirmLink} onChange={(e) => setConfirmLink(e.target.checked)} />
                  {' '}I understand that anyone who has the link can view, and that forwarded links cannot be recalled.
                </label>
                {shareLink && <CopyField label="Link (shown once)" value={shareLink} />}
              </div>
            )}
            <hr />
            <label>
              <input type="checkbox" checked={includeMedia} onChange={(e) => { setIncludeMedia(e.target.checked); if (!e.target.checked) setAllowOriginals(false); }} />
              {' '}{COPY.sharesMedia}
            </label>
            <label>
              <input type="checkbox" checked={allowOriginals} onChange={(e) => {
                // Originals are an additional option on top of included media.
                setAllowOriginals(e.target.checked);
                if (e.target.checked) setIncludeMedia(true);
              }} />
              {' '}{COPY.sharesDownload}
            </label>
            <p className="as-muted">{COPY.sharesLive}</p>
          </div>
          <div className="as-panel">
            <h2>{title}</h2>
            {title === 'Currently private' ? (
              <>
                <p>Only you can view this collection.</p>
                <p>Invited people can view after signing in with the invited email.</p>
                <p>Link access, if enabled, expires after 7 days by default.</p>
              </>
            ) : (
              <>
                {restricted && (
                  <p>
                    {members > 0 ? `${members} ${members === 1 ? 'person' : 'people'} can view after signing in` : 'No one has accepted yet'}
                    {pendingInvites > 0 ? ` · ${pendingInvites} ${pendingInvites === 1 ? 'invitation' : 'invitations'} pending` : ''}
                    {' · '}{restricted.include_media ? 'Photos and videos included' : 'Photos and videos not included'}
                  </p>
                )}
                {restricted && restricted.members.length > 0 && (
                  <ul className="as-list">{restricted.members.map((m, i) => <li key={i}>{m.display_name ?? 'Invited viewer'}</li>)}</ul>
                )}
                {links.map((l) => (
                  <p key={l.id}>Link · {expiresIn(l.expires_at).toLowerCase()} · {l.include_media ? 'photos and videos included' : 'no photos or videos'}</p>
                ))}
              </>
            )}
            <button type="button" className="as-primary" disabled={busy || loading || (audience === 'link' && !confirmLink)} onClick={() => void act(async () => {
              if (audience === 'link') {
                const created = await api.request('createShare', {
                  params: { id: collectionId },
                  body: { audience: 'link', expires_in_days: linkDays, include_media: false, allow_originals: false, confirm_policy: true },
                  idempotencyKey: newIdempotencyKey(),
                });
                setShareLink(created.link);
                setConfirmLink(false);
                if (includeMedia && !(await applyPolicy(created.share, includeMedia, allowOriginals))) return;
                setStatus('Link created. Copy it now; it is shown once.');
              } else {
                const share = await ensureRestricted();
                if (!(await applyPolicy(share, includeMedia, allowOriginals))) return;
                setStatus('Sharing settings saved.');
              }
              await load();
            })}>{busy ? 'Saving…' : 'Save sharing settings'}</button>
            {audience === 'link' && !confirmLink && <p className="as-muted">Confirm link access to create a link.</p>}
            {pending && (
              <div role="group" aria-labelledby={`${ids}-preview`}>
                <h2 id={`${ids}-preview`}>Confirm what becomes visible</h2>
                {pending.preview.length > 0 ? (
                  <>
                    <p>{pending.preview.length} {pending.preview.length === 1 ? 'item becomes' : 'items become'} visible to {pending.share.audience === 'link' ? 'anyone with the link' : 'invited people'}:</p>
                    <ul className="as-list">{pending.preview.map((p) => <li key={p.id}>{p.title ?? (p.kind === 'video' ? 'Video' : 'Photo')} · {p.kind}</li>)}</ul>
                  </>
                ) : pending.broadening.includes('include_media') ? <p>No captured photos or videos are in this collection yet. New ones you add will become visible.</p> : null}
                {pending.broadening.includes('allow_originals') && <p>Viewers will be able to download original files.</p>}
                <div className="as-actions">
                  <button type="button" className="as-primary" disabled={busy} onClick={() => void act(async () => {
                    await applyPolicy(pending.share, pending.include_media, pending.allow_originals, true);
                    setPending(null);
                    setStatus('Sharing settings saved.');
                    await load();
                  })}>Include them</button>
                  <button type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                </div>
              </div>
            )}
            {(restricted || links.length > 0) && <hr />}
            {[...(restricted ? [restricted] : []), ...links].map((s) => (
              <div key={s.id}>
                {revoking?.id === s.id ? (
                  <div role="group" aria-label="Confirm stop sharing">
                    <p>{s.audience === 'link' ? 'Turn off this link? It stops working immediately.' : 'Stop sharing with invited people? They lose access immediately.'}</p>
                    <div className="as-actions">
                      <button type="button" className="as-danger" disabled={busy} onClick={() => void act(async () => {
                        await api.request('revokeShare', { params: { id: s.id }, idempotencyKey: newIdempotencyKey() });
                        setRevoking(null);
                        setStatus(s.audience === 'link' ? 'Link turned off.' : 'Stopped sharing with invited people.');
                        await load();
                      })}>{s.audience === 'link' ? 'Turn off link' : 'Stop sharing'}</button>
                      <button type="button" disabled={busy} onClick={() => setRevoking(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="as-link-button" onClick={() => setRevoking(s)}>
                    {s.audience === 'link' ? `Turn off link (${expiresIn(s.expires_at).toLowerCase()})` : 'Stop sharing with invited people'}
                  </button>
                )}
              </div>
            ))}
            <p role="status" aria-live="polite" className="as-muted">{status}</p>
            {error && <p role="alert" className="as-alert">{error}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
