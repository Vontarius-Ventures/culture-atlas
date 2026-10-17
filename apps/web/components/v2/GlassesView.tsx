'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, CSRF_HEADER } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { COPY } from './copy';
import {
  mediaApi,
  mediaErrorMessage,
  readV2Error,
  type Capabilities,
  type MediaDetail,
} from './media-api';
import { ACCEPT_MEDIA } from './media-format';
import { ExperimentalBadge, FlowHeader, V2Notice } from './parts';
import { loadCapabilities, useUploads } from './uploads-client';
import { GlassesArt } from './V2Icon';
import { thumbFor } from './LibraryView';

/** Reason codes from GET /v2/capabilities, grouped the way people act on them. */
const REASON_GROUPS: Array<{ key: string; label: string; codes: string[]; text: string }> = [
  {
    key: 'release',
    label: 'App release',
    codes: ['release_channel_ineligible', 'temporarily_disabled'],
    text: 'Glasses capture is not enabled for this app release.',
  },
  {
    key: 'country',
    label: 'Country or account',
    codes: ['rollout_unavailable'],
    text: 'Glasses capture is not offered in your country or for your account yet.',
  },
  {
    key: 'device',
    label: 'Device',
    codes: ['build_unsupported', 'device_unsupported'],
    text: 'Glasses connect through the culture atlas app on a supported phone, not in a web browser.',
  },
  {
    key: 'permission',
    label: 'Permission',
    codes: ['permission_required', 'user_action_required'],
    text: 'Camera access for your glasses is allowed in Meta AI on your phone.',
  },
];
/** Account-wide or release blockers: no hand-off and no fake reconnect. */
const BLOCKING = new Set([
  'release_channel_ineligible',
  'temporarily_disabled',
  'rollout_unavailable',
]);

type HandoffState =
  | { state: 'none' }
  | { state: 'checking' }
  | { state: 'valid'; same: boolean | null }
  | { state: 'expired' | 'invalid' };

/**
 * Meta glasses on the web (references 04 and 09). Browsers never pair over
 * Bluetooth: this screen explains eligibility from server capabilities, offers
 * camera and uploads, and hands setup to the phone app through a signed,
 * short-lived, account-bound link.
 */
export function GlassesView({ back }: { back: { href: string; label: string } }) {
  const router = useRouter();
  const params = useSearchParams();
  const { session, isAccount } = useSession();
  const { engine } = useUploads();
  const [caps, setCaps] = useState<Capabilities | null | 'error'>(null);
  const [handoff, setHandoff] = useState<HandoffState>({ state: 'none' });
  const [about, setAbout] = useState(false);
  const [recent, setRecent] = useState<MediaDetail[]>([]);
  const upload = useRef<HTMLInputElement>(null);
  const token = params.get('handoff');

  useEffect(() => {
    if (!session) return;
    if (!isAccount) {
      void Promise.resolve().then(() => setCaps('error'));
      return;
    }
    loadCapabilities()
      .then(setCaps)
      .catch(() => setCaps('error'));
    mediaApi
      .library({ kind: 'photo', status: 'ready', limit: 3 })
      .then((r) => setRecent(r.items))
      .catch(() => setRecent([]));
  }, [session, isAccount]);

  useEffect(() => {
    if (!token || !session) return;
    void Promise.resolve().then(() => setHandoff({ state: 'checking' }));
    fetch(`/capture/handoff?token=${encodeURIComponent(token)}`, { credentials: 'same-origin' })
      .then(
        (r) =>
          r.json() as Promise<{
            status: 'valid' | 'expired' | 'invalid';
            same_account: boolean | null;
          }>,
      )
      .then((r) =>
        setHandoff(
          r.status === 'valid' ? { state: 'valid', same: r.same_account } : { state: r.status },
        ),
      )
      .catch(() => setHandoff({ state: 'invalid' }));
  }, [token, session]);

  const reasons = caps && caps !== 'error' ? (caps.availability.meta_glasses?.reasons ?? []) : [];
  const available =
    caps && caps !== 'error' ? caps.availability.meta_glasses?.available === true : false;
  const blocked = reasons.some((r) => BLOCKING.has(r));
  const groups = REASON_GROUPS.filter((g) => g.codes.some((c) => reasons.includes(c)));

  const onFiles = async (files: File[]) => {
    if (!files.length || !engine) return;
    await engine.add(files, 'upload').catch(() => undefined);
    router.push('/uploads');
  };

  const uploadInput = (
    <input
      ref={upload}
      type="file"
      multiple
      accept={ACCEPT_MEDIA}
      className="library__upload-input"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        void onFiles([...(e.target.files ?? [])]);
        e.target.value = '';
      }}
    />
  );

  const aboutPanel = (
    <div className="about-panel" id="about-experimental" hidden={!about}>
      <p>
        Meta glasses support is experimental. It works only in the culture atlas phone app, on
        phones and app releases we have tested, after you connect your own glasses in Meta AI and
        allow camera access.
      </p>
      {groups.length > 0 && (
        <ul aria-label="Why it is not available">
          {groups.map((g) => (
            <li key={g.key}>
              <strong>{g.label}:</strong> {g.text}
            </li>
          ))}
        </ul>
      )}
      <ul>
        <li>
          Not every glasses model supports every feature. Video length and audio may be limited.
        </li>
        <li>Glasses audio is off unless you turn it on in the app.</li>
        <li>You decide when to capture. Everything goes to your private library.</li>
      </ul>
    </div>
  );

  const handoffBanner =
    handoff.state === 'none' ? null : (
      <div style={{ marginTop: 16 }}>
        {handoff.state === 'checking' && <V2Notice>Checking your link…</V2Notice>}
        {handoff.state === 'valid' && handoff.same === true && (
          <V2Notice>
            Opened from your computer. Continue in the culture atlas app on this phone.
          </V2Notice>
        )}
        {handoff.state === 'valid' && handoff.same === false && (
          <V2Notice tone="error">
            This link belongs to a different account. Sign in to the account that created it.
          </V2Notice>
        )}
        {handoff.state === 'valid' && handoff.same === null && (
          <V2Notice
            actions={
              <Link href="/identity" className="button button--primary button--small">
                Sign in
              </Link>
            }
          >
            Sign in with the same account you use on your computer to continue.
          </V2Notice>
        )}
        {(handoff.state === 'expired' || handoff.state === 'invalid') && (
          <V2Notice tone="error">
            {handoff.state === 'expired'
              ? 'This link has expired. Create a new one on your computer.'
              : 'This link is not valid. Create a new one on your computer.'}
          </V2Notice>
        )}
      </div>
    );

  if (caps === null)
    return (
      <div className="glasses">
        <FlowHeader href={back.href} label={back.label} wordmark={false} />
        <p className="loading-text" role="status">
          Checking glasses availability…
        </p>
      </div>
    );

  // 09: release/country/kill-switch blockers. No reconnect for distribution blockers.
  if (caps !== 'error' && !available && blocked) {
    const primary = groups[0];
    return (
      <div className="glasses unavailable">
        <FlowHeader href={back.href} label="" arrow="arrow" />
        {uploadInput}
        <div style={{ textAlign: 'left' }}>
          <Link href={back.href} className="v2-back desktop-only">
            ← {back.label}
          </Link>
          <h1 className="glasses__title" style={{ marginTop: 8 }}>
            {COPY['capture.glasses']}
          </h1>
          <div style={{ marginTop: 10 }}>
            <ExperimentalBadge quiet />
          </div>
        </div>
        {handoffBanner}
        <GlassesArt className="unavailable__art" />
        <h2 className="unavailable__title">Not available yet</h2>
        <p className="unavailable__text">
          {primary?.key === 'release'
            ? COPY['glasses.unavailable']
            : `${primary?.text ?? 'Glasses capture is not available right now.'} Your camera and uploads are ready to use.`}
        </p>
        <div className="unavailable__actions">
          <Link href="/capture/camera?start=1" className="button button--primary">
            Use this camera
          </Link>
          <button
            type="button"
            className="button button--outline"
            onClick={() => upload.current?.click()}
            disabled={!isAccount}
          >
            {COPY['capture.upload']}
          </button>
        </div>
        <div className="unavailable__about">
          <button
            type="button"
            className="text-button"
            aria-expanded={about}
            aria-controls="about-experimental"
            onClick={() => setAbout((a) => !a)}
          >
            About experimental access
          </button>
          {aboutPanel}
        </div>
        {recent.length > 0 && (
          <section className="unchanged" aria-labelledby="unchanged-title">
            <h2 id="unchanged-title" className="unchanged__title">
              Your library is unchanged.
            </h2>
            <p className="unchanged__text">Already captured photos and videos stay available.</p>
            <ul className="unchanged__grid">
              {recent.map((m) => (
                <li key={m.media.id}>
                  <Link href={`/library/media/${m.media.id}`} aria-label="Open in your library">
                    {thumbFor(m) && <img src={thumbFor(m)!} alt="" loading="lazy" />}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  // 04: connect guidance on the web; setup happens in the phone app.
  return (
    <div className="glasses">
      <FlowHeader href={back.href} label={back.label} wordmark={false} />
      {uploadInput}
      <Link href={back.href} className="v2-back desktop-only">
        ← {back.label}
      </Link>
      <div style={{ marginTop: 8 }}>
        <ExperimentalBadge />
      </div>
      <h1 className="glasses__title">Connect your glasses</h1>
      <p className="glasses__lede">Use your own Meta glasses with culture atlas.</p>
      {handoffBanner}
      <img className="glasses__hero" src="/capture/glasses-hero.jpg" alt="" />
      <ol className="steps">
        <li className="step">
          <span className="step__num" aria-hidden="true">
            1
          </span>
          <div>
            <h2 className="step__title">Pair in Meta AI</h2>
            <p className="step__sub">Connect your glasses to this phone.</p>
          </div>
        </li>
        <li className="step">
          <span className="step__num" aria-hidden="true">
            2
          </span>
          <div>
            <h2 className="step__title">Allow camera access</h2>
            <p className="step__sub">You choose when to capture.</p>
          </div>
        </li>
        <li className="step">
          <span className="step__num" aria-hidden="true">
            3
          </span>
          <div>
            <h2 className="step__title">Take a test photo</h2>
            <p className="step__sub">See it in your private library.</p>
          </div>
        </li>
      </ol>
      <PhoneStep signedIn={isAccount} />
      <p className="glasses__foot">Availability depends on your device and app access.</p>
      <div className="glasses__alt">
        <Link href="/capture/camera?start=1" className="text-button">
          Use this camera instead
        </Link>
      </div>
      <div className="glasses__alt">
        <button
          type="button"
          className="text-button"
          aria-expanded={about}
          aria-controls="about-experimental"
          onClick={() => setAbout((a) => !a)}
          style={{ fontSize: 14, color: 'var(--muted)' }}
        >
          About experimental access
        </button>
      </div>
      {aboutPanel}
    </div>
  );
}

/** Mobile: open the phone app. Desktop: create the signed phone link (QR + copyable URL). */
function PhoneStep({ signedIn }: { signedIn: boolean }) {
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!link) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [link]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setCopied('idle');
    try {
      const s = await api.getSession();
      const res = await fetch('/capture/handoff', {
        method: 'POST',
        headers: { [CSRF_HEADER]: s.csrf_token, accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) throw new ApiError(res.status, await readV2Error(res));
      setLink((await res.json()) as { url: string; expires_at: string });
    } catch (err) {
      setError(mediaErrorMessage(err, 'The phone link could not be created. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const left = link ? Math.max(0, Date.parse(link.expires_at) - now) : 0;
  const expired = link !== null && left === 0;

  return (
    <>
      <a
        className="button button--primary glasses__primary mobile-only"
        href="cultureatlas://capture/glasses"
      >
        Open the culture atlas app
      </a>
      {!link && (
        <button
          type="button"
          className="button button--primary glasses__primary desktop-only"
          onClick={() => void create()}
          disabled={!signedIn || busy}
          aria-describedby={signedIn ? undefined : 'phone-signin'}
        >
          {busy ? 'Creating link…' : 'Continue on your phone'}
        </button>
      )}
      {!signedIn && (
        <p id="phone-signin" className="glasses__foot desktop-only">
          <Link href="/identity" className="text-button">
            Sign in
          </Link>{' '}
          to create a link for your phone.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {link && (
        <section className="handoff desktop-only" aria-labelledby="handoff-title">
          <h2 id="handoff-title" className="handoff__title">
            Open this on your phone
          </h2>
          {!expired ? (
            <div className="handoff__body">
              <QrCode value={link.url} />
              <div>
                <p>
                  Scan with your phone camera, or send yourself the link. It only opens for your
                  account.
                </p>
                <label className="visually-hidden" htmlFor="handoff-url">
                  Phone link
                </label>
                <input
                  id="handoff-url"
                  className="handoff__url"
                  readOnly
                  value={link.url}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="handoff__actions">
                  <button
                    type="button"
                    className="button button--outline button--small"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(link.url);
                        setCopied('copied');
                      } catch {
                        setCopied('failed');
                      }
                    }}
                  >
                    Copy link
                  </button>
                </div>
                <p className="handoff__meta" role="status">
                  {copied === 'copied'
                    ? 'Copied'
                    : copied === 'failed'
                      ? 'Copy did not work. Select the link and copy it.'
                      : `Expires in ${Math.ceil(left / 60000)} min.`}
                </p>
              </div>
            </div>
          ) : (
            <div className="handoff__actions">
              <p>This link expired.</p>
              <button
                type="button"
                className="button button--primary button--small"
                onClick={() => void create()}
              >
                Create a new link
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function QrCode({ value }: { value: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const rects: Array<[number, number]> = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) rects.push([c, r]);
    return { n, rects };
  }, [value]);
  return (
    <div className="handoff__qr">
      <svg
        viewBox={`-2 -2 ${cells.n + 4} ${cells.n + 4}`}
        role="img"
        aria-label="QR code for the phone link"
        shapeRendering="crispEdges"
      >
        <rect x={-2} y={-2} width={cells.n + 4} height={cells.n + 4} fill="#fff" />
        <path d={cells.rects.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join('')} fill="#252823" />
      </svg>
    </div>
  );
}
