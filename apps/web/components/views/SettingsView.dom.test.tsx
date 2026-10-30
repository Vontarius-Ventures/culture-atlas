import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as uploadStore from '../v2/upload-store';
import { MemoryUploadStore, type UploadEntry } from '../v2/upload-store';

type UploadStoreModule = typeof uploadStore;
import { AccountSection, pendingLocalDrafts } from './SettingsView';

const store = new MemoryUploadStore();
const request = vi.fn(async () => ({}));
vi.mock('@/lib/client/session', () => ({
  useSession: () => ({ isAccount: true, session: { principal: { kind: 'account', account_id: 'acc-1' } } }),
}));
vi.mock('@/lib/client/api', () => ({
  api: { request: (...args: unknown[]) => request(...(args as [])), refreshSession: vi.fn(async () => undefined) },
  ApiError: class extends Error {},
  newIdempotencyKey: () => 'key',
}));
vi.mock('../v2/upload-store', async (original) => ({
  ...(await original<UploadStoreModule>()),
  defaultUploadStore: () => store,
}));

function draft(id: string, over: Partial<UploadEntry> = {}): UploadEntry {
  return {
    client_capture_id: id, account_id: 'acc-1', filename: `${id}.jpg`, kind: 'photo', content_type: 'image/jpeg',
    source: 'upload', byte_size: 3, sha256: null, captured_at: null, duration_ms: null, width: null, height: null,
    added_at: '2026-10-17T00:00:00Z', updated_at: '2026-10-17T00:00:00Z', blob: new Blob(['abc']), thumb: null,
    create_key: 'k1', complete_key: 'k2', upload_id: null, asset_id: null, part_size: null, part_count: null,
    receipts: [], phase: 'paused', pause_reason: 'user', error: null, media_status: null, ...over,
  };
}

beforeEach(async () => {
  for (const e of await store.all()) await store.delete(e.client_capture_id);
  request.mockClear();
});
afterEach(cleanup);

describe('sign-out with pending local uploads (SCREEN-CONTRACT Upload rule)', () => {
  it('counts only this account’s drafts that still hold bytes', () => {
    const entries = [draft('a'), draft('b', { account_id: 'other' }), draft('c', { blob: null, phase: 'ready' })];
    expect(pendingLocalDrafts(entries, 'acc-1').map((e) => e.client_capture_id)).toEqual(['a']);
    expect(pendingLocalDrafts(entries, null)).toEqual([]);
  });

  it('asks Keep on this device or Delete local drafts before signing out', async () => {
    await store.put(draft('a'));
    await store.put(draft('b', { account_id: 'other' }));
    render(<AccountSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText(/1 file is still only on this device/)).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete local drafts' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('signOut', { body: {} }));
    // Only this account's draft was deleted.
    expect((await store.all()).map((e) => e.client_capture_id)).toEqual(['b']);
  });

  it('keeps the drafts when asked, and signs out directly when nothing is pending', async () => {
    await store.put(draft('a'));
    render(<AccountSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep on this device' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('signOut', { body: {} }));
    expect((await store.all()).map((e) => e.client_capture_id)).toEqual(['a']);
    cleanup();
    request.mockClear();
    await store.delete('a');
    render(<AccountSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('signOut', { body: {} }));
    expect(screen.queryByText(/still only on this device/)).toBeNull();
  });

  it('offers the first-party deletion entry and changes nothing when it is only opened', () => {
    render(<AccountSection />);
    const entry = screen.getByRole('link', { name: /Delete account/ });
    expect(entry.closest('a')?.getAttribute('href')).toBe('/settings/deletion');
    // Merely exposing the entry touches nothing: no sign-out, no request.
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});
