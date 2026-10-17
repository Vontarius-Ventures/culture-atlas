'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/client/api';
import { relativeTime } from '@/lib/client/format';
import { useSession } from '@/lib/client/session';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { CORRECTIONS } from './copy';
import { isSignedOutError, mediaApi, mediaErrorMessage, type CaptureDevice } from './media-api';
import { ExperimentalBadge, FlowHeader, SignInPanel, V2Notice } from './parts';
import { V2Icon } from './V2Icon';

/** Heartbeat freshness (BACKEND-CONTRACTS: default 30 seconds). */
export const FRESH_MS = 30_000;

export function deviceName(d: CaptureDevice): string {
  return d.platform === 'ios' ? 'iPhone' : 'Android phone';
}

/** Actual state in words. Stale status is never labelled Ready. */
export function deviceState(d: CaptureDevice, now = Date.now()): { label: string; ready: boolean } {
  if (d.revoked_at) return { label: 'Removed', ready: false };
  const fresh = now - Date.parse(d.last_seen_at) <= FRESH_MS;
  if (!fresh) return { label: `Last seen ${relativeTime(d.last_seen_at)}`, ready: false };
  if (d.readiness === 'ready' && d.app_state === 'foreground')
    return { label: 'Ready to capture', ready: true };
  if (d.readiness === 'user_action_required')
    return { label: 'Needs attention on the phone', ready: false };
  if (d.app_state !== 'foreground') return { label: 'App in background', ready: false };
  return { label: 'Not ready', ready: false };
}

const CAPABILITY_LABELS: Record<string, string> = {
  photo: 'Photos',
  camera_photo: 'Photos',
  video: 'Video',
  camera_video: 'Video',
  meta_glasses: 'Meta glasses',
  glasses: 'Meta glasses',
  background_upload: 'Background upload',
  audio: 'Audio',
};

function capabilityList(d: CaptureDevice): string[] {
  const labels = Object.entries(d.capabilities)
    .filter(([, on]) => on)
    .map(([k]) => CAPABILITY_LABELS[k])
    .filter((x): x is string => Boolean(x));
  return [...new Set(labels)];
}

function useDevices() {
  const { session, isAccount } = useSession();
  const [devices, setDevices] = useState<CaptureDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const all: CaptureDevice[] = [];
      const res = await mediaApi.devices();
      all.push(...res.items);
      setDevices(all);
    } catch (err) {
      if (isSignedOutError(err)) setSignedOut(true);
      else setError(mediaErrorMessage(err, 'Your devices could not load.'));
    }
  }, []);
  useEffect(() => {
    if (!session) return;
    if (!isAccount) {
      void Promise.resolve().then(() => setSignedOut(true));
      return;
    }
    void Promise.resolve().then(load);
  }, [session, isAccount, load]);
  return { devices, setDevices, error, signedOut, load };
}

function RemoveDevice({ device, onRemoved }: { device: CaptureDevice; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = deviceName(device);
  if (!confirming)
    return (
      <button
        type="button"
        className="button button--outline button--small"
        onClick={() => setConfirming(true)}
      >
        Remove
      </button>
    );
  return (
    <div className="confirm" role="group" aria-label={`Remove ${name}`}>
      <p>
        Remove this {name}? It stops uploading and taking requests right away. Photos and videos it
        already uploaded stay in your library.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="confirm__actions">
        <button
          type="button"
          className="button button--outline button--small"
          onClick={() => setConfirming(false)}
        >
          Keep it
        </button>
        <button
          type="button"
          className="button button--danger button--small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await mediaApi.revokeDevice(device.id, device.revision);
              onRemoved();
            } catch (err) {
              setError(
                err instanceof ApiError && err.code === 'conflict'
                  ? 'This phone changed. Reload and try again.'
                  : mediaErrorMessage(err, 'It could not be removed. It is still connected.'),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Removing…' : `Remove ${name}`}
        </button>
      </div>
    </div>
  );
}

/** Settings → Devices: the account's phones, their fresh state, removal, and the glasses entry. */
export function DevicesView() {
  const toast = useToast();
  const { devices, setDevices, error, signedOut, load } = useDevices();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const active = devices?.filter((d) => !d.revoked_at) ?? [];

  return (
    <div className="v2-page devices">
      <FlowHeader href="/settings" label="Settings" wordmark={false} />
      <Link href="/settings" className="v2-back desktop-only">
        <Icon name="arrowLeft" size={20} /> Settings
      </Link>
      <h1 className="v2-title" style={{ marginTop: 8 }}>
        Devices
      </h1>
      <p className="v2-subtitle v2-subtitle--ui">
        Phones signed in to your account and your glasses.
      </p>
      {signedOut ? (
        <SignInPanel title="Sign in to manage devices." />
      ) : (
        <>
          <section className="devices__section" aria-labelledby="phones-title">
            <h2 id="phones-title" className="devices__section-title">
              Phones
            </h2>
            <p className="devices__section-text">
              Sign in to the culture atlas app on your phone to add it here. Removing a phone stops
              its access right away; what it already uploaded stays in your library.
            </p>
            {error && (
              <div style={{ marginTop: 16 }}>
                <V2Notice
                  tone="error"
                  actions={
                    <button
                      type="button"
                      className="button button--outline button--small"
                      onClick={() => void load()}
                    >
                      Try again
                    </button>
                  }
                >
                  {error}
                </V2Notice>
              </div>
            )}
            {!devices && !error && (
              <p className="loading-text" role="status">
                Loading devices…
              </p>
            )}
            {devices && active.length === 0 && (
              <p className="muted" style={{ marginTop: 16 }}>
                No phones yet.
              </p>
            )}
            {active.length > 0 && (
              <ul className="devices__list" style={{ marginTop: 16 }}>
                {active.map((d) => {
                  const s = deviceState(d, now);
                  return (
                    <li key={d.id} className="devices__row">
                      <V2Icon name="phone" size={32} />
                      <div>
                        <p className="device-card__name">
                          <Link href={`/settings/devices/${d.id}`} className="device-link">
                            {deviceName(d)}
                          </Link>
                          <span className={`live-state${s.ready ? ' live-state--ready' : ''}`}>
                            {s.label}
                          </span>
                        </p>
                        <p className="device-card__sub">
                          App {d.app_version}
                          {capabilityList(d).length ? ` · ${capabilityList(d).join(', ')}` : ''}
                        </p>
                      </div>
                      <div className="devices__row-actions">
                        <RemoveDevice
                          device={d}
                          onRemoved={() => {
                            setDevices((prev) => prev?.filter((x) => x.id !== d.id) ?? null);
                            toast.show({ message: `${deviceName(d)} removed` });
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="devices__section" aria-labelledby="glasses-title">
            <h2
              id="glasses-title"
              className="devices__section-title"
              style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
            >
              Meta glasses <ExperimentalBadge />
            </h2>
            <p className="devices__section-text">
              Glasses connect to your phone in Meta AI, then to culture atlas in the phone app. A
              web browser never pairs with glasses.
            </p>
            <Link
              href="/settings/devices/glasses"
              className="device-card"
              style={{ maxWidth: 560 }}
            >
              <V2Icon name="glasses" size={40} />
              <span>
                <span className="device-card__name">Connect your glasses</span>
                <span className="device-card__sub" style={{ display: 'block' }}>
                  Check availability and set up on your phone
                </span>
              </span>
              <Icon name="chevronRight" size={22} />
            </Link>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * One phone (web view of reference 05): actual connection state from its last
 * heartbeat, eligible capture modes, and remote capture. Remote capture is
 * armed only on the phone itself, so the browser shows it read-only.
 */
export function DeviceDetailView({ id }: { id: string }) {
  const toast = useToast();
  const { devices, error, signedOut, load } = useDevices();
  const [now, setNow] = useState(() => Date.now());
  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 15_000);
    return () => clearInterval(t);
  }, [load]);
  const device = devices?.find((d) => d.id === id) ?? null;

  const header = (
    <>
      <FlowHeader href="/settings/devices" label="Devices" />
      <Link href="/settings/devices" className="v2-back desktop-only">
        <Icon name="arrowLeft" size={20} /> Devices
      </Link>
    </>
  );

  if (signedOut)
    return (
      <div className="glasses">
        {header}
        <SignInPanel title="Sign in to manage devices." />
      </div>
    );
  if (error)
    return (
      <div className="glasses">
        {header}
        <V2Notice
          tone="error"
          actions={
            <button
              type="button"
              className="button button--outline button--small"
              onClick={() => void load()}
            >
              Try again
            </button>
          }
        >
          {error}
        </V2Notice>
      </div>
    );
  if (!devices)
    return (
      <div className="glasses">
        {header}
        <p className="loading-text" role="status">
          Loading…
        </p>
      </div>
    );
  if (!device || device.revoked_at)
    return (
      <div className="glasses">
        {header}
        <section className="v2-empty">
          <h1 className="v2-empty__title">This phone is not connected to your account.</h1>
          <div className="v2-empty__actions">
            <Link href="/settings/devices" className="button button--outline">
              All devices
            </Link>
          </div>
        </section>
      </div>
    );

  const state = deviceState(device, now);
  const glasses = Boolean(device.capabilities.meta_glasses || device.capabilities.glasses);
  const videoOk = Boolean(device.capabilities.video || device.capabilities.camera_video);
  return (
    <div className="glasses">
      {header}
      <h1 className="glasses__title" style={{ marginTop: 8 }}>
        {glasses ? 'Your glasses' : deviceName(device)}
      </h1>
      <p className="muted" style={{ marginTop: 6 }}>
        {glasses ? 'Experimental' : `App ${device.app_version}`}
      </p>
      <div className="device-card">
        <V2Icon name={glasses ? 'glasses' : 'phone'} size={44} />
        <div>
          <p className="device-card__name">
            {glasses ? 'Meta glasses' : deviceName(device)}
            <span className={`live-state${state.ready ? ' live-state--ready' : ''}`} role="status">
              {state.label}
            </span>
          </p>
          <p className="device-card__sub">
            {glasses
              ? `Connected through your ${deviceName(device)}`
              : `Last seen ${relativeTime(device.last_seen_at)}`}
          </p>
        </div>
      </div>

      <div className="ready__modes" role="group" aria-label="Capture mode">
        <button
          type="button"
          className="ready__mode"
          aria-pressed={mode === 'photo'}
          onClick={() => setMode('photo')}
        >
          photo
        </button>
        <button
          type="button"
          className="ready__mode"
          aria-pressed={mode === 'video'}
          disabled={!videoOk}
          onClick={() => setMode('video')}
        >
          video
        </button>
      </div>
      <div className="ready__shutter">
        <button
          type="button"
          className="shutter"
          disabled
          aria-describedby="remote-why"
          aria-label={mode === 'photo' ? 'Take photo' : 'Record video'}
        >
          <span className="shutter__inner">
            <Icon name="camera" size={30} />
          </span>
        </button>
        <span className="ready__label">{mode === 'photo' ? 'Take photo' : 'Record video'}</span>
        <span className="ready__meta">
          {state.ready ? 'Camera ready' : 'Camera not ready'} · Audio off
        </span>
      </div>

      <section className="remote" aria-labelledby="remote-title">
        <h2 id="remote-title" className="remote__title">
          Capture from your browser
        </h2>
        <p className="remote__text">{CORRECTIONS.remoteCapture}.</p>
        <div className="switch-row">
          <label htmlFor="remote-toggle">Allow remote capture</label>
          <input
            id="remote-toggle"
            type="checkbox"
            role="switch"
            className="switch"
            checked={false}
            disabled
            aria-describedby="remote-why"
            readOnly
          />
        </div>
        <p id="remote-why" className="muted" style={{ fontSize: 15 }}>
          Remote capture is off. Turn it on in the culture atlas app on this phone and choose which
          agents may ask; it turns off by itself after 10 minutes.
        </p>
      </section>

      <section className="remote" aria-labelledby="remove-title">
        <h2 id="remove-title" className="remote__title">
          Remove this phone
        </h2>
        <p className="remote__text">
          It stops uploading and taking requests right away. Past media stays in your library.
        </p>
        <div style={{ marginTop: 12 }}>
          <RemoveDevice
            device={device}
            onRemoved={() => {
              toast.show({ message: `${deviceName(device)} removed` });
              void load();
            }}
          />
        </div>
      </section>
    </div>
  );
}
