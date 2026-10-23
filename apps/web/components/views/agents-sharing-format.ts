import type { Scope } from '@culture-atlas/domain';

/**
 * Pure presentation helpers for screens 10–13. Exact copy comes from
 * specs/capture-platform-v2/design/copy.json (COPY below) and the readable
 * consent verbs in SCREEN-CONTRACT "Agent consent".
 */

export const COPY = {
  agentsTitle: 'Connected agents',
  agentsSubtitle: 'Choose what each agent can see and do.',
  agentsRemote: 'Request capture while I allow it',
  agentsRemoteNotice: 'Capture also requires permission on your phone.',
  sharesRestricted: 'Restricted',
  sharesLink: 'Anyone with the link',
  sharesNotice: 'Anyone with this link can view the items you include.',
  sharesLive: 'New items added to this collection follow these sharing settings.',
  sharesMedia: 'Include captured photos and videos',
  sharesDownload: 'Allow original downloads',
  sharesRevoked: 'This collection is no longer shared.',
} as const;

/** Short labels for a connection card ("View device setup · Read preferences"). */
export const SHORT_SCOPE_LABELS: Record<Scope, string> = {
  'setup:read': 'View device setup',
  'preferences:read': 'Read preferences',
  'preferences:write': 'Change preferences',
  'collections:read': 'View collections',
  'collections:write': 'Organize collections',
  'media:read': 'View photos and videos',
  'media:download': 'Download originals',
  'media:write': 'Upload media',
  'media:analyze': 'Request analysis',
  'devices:command': 'Request capture',
  'captures:read': 'See photo discoveries',
  'captures:write': 'Add photos',
  'taste:read': 'See saved items',
  'taste:write': 'Save items',
  'plans:read': 'See plans',
  'plans:write': 'Change plans',
};

/** Consent order (SCREEN-CONTRACT "Agent consent"): setup, preferences, collections, media, capture. */
const SCOPE_ORDER: readonly Scope[] = [
  'setup:read', 'preferences:read', 'preferences:write', 'collections:read', 'collections:write',
  'media:read', 'media:download', 'media:write', 'media:analyze', 'devices:command',
  'captures:read', 'captures:write', 'taste:read', 'taste:write', 'plans:read', 'plans:write',
];

/**
 * The capability line on a connection card ("View device setup · Read preferences"),
 * in consent order. Collection reading is spelled out by the card's own
 * "Collections: …" line, so it is not repeated here when collections are granted.
 */
export function connectionScopeLine(scopes: readonly Scope[], library: 'none' | 'selected_collections' | 'all'): string {
  const rank = (s: Scope) => {
    const i = SCOPE_ORDER.indexOf(s);
    return i === -1 ? SCOPE_ORDER.length : i;
  };
  return [...scopes]
    .filter((s) => !(s === 'collections:read' && library !== 'none'))
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => SHORT_SCOPE_LABELS[s])
    .join(' · ');
}

const ACTIVITY: Record<string, string> = {
  'preferences.read': 'Read your preferences',
  'preferences.update': 'Changed your preferences',
  'setup.read': 'Viewed your device setup',
  'media.list': 'Listed permitted photos and videos',
  'media.begin_upload': 'Started an upload',
  'media.analyze': 'Requested analysis',
  'media.original_download': 'Downloaded an original',
  'capture.capture_photo': 'Requested a photo',
  'capture.start_video': 'Requested a video',
  'capture.stop_video': 'Asked to stop a video',
};

/** Owner-facing activity line: "Read your preferences", "Viewed Quiet weekends". */
export function activityLabel(action: string, targetLabel?: string | null): string {
  if (action === 'collection.read') return targetLabel ? `Viewed ${targetLabel}` : 'Viewed a collection';
  return ACTIVITY[action] ?? action.replaceAll('.', ' ').replaceAll('_', ' ');
}

export const isCaptureActivity = (action: string) => action.startsWith('capture.');

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today, 10:42", "Yesterday, 18:05" or "Oct 12, 09:30" (24-hour clock, local time). */
export function dayTime(iso: string, now = new Date()): string {
  const t = new Date(iso);
  const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (sameDay(t, now)) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(t, yesterday)) return `Yesterday, ${time}`;
  return `${t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/** "Expires in 24 days", "Expires tomorrow", "Expired". */
export function expiresIn(iso: string | null, now = Date.now()): string {
  if (!iso) return 'No expiry';
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'Expired';
  const days = Math.ceil(ms / 86_400_000);
  if (days <= 1) return 'Expires within a day';
  return `Expires in ${days} days`;
}

/** "Last used today", "Last used yesterday", "Last used 3 days ago", "Not used yet". */
export function lastUsed(iso: string | null, now = new Date()): string {
  if (!iso) return 'Not used yet';
  const t = new Date(iso);
  if (sameDay(t, now)) return 'Last used today';
  const days = Math.max(1, Math.round((now.getTime() - t.getTime()) / 86_400_000));
  return days === 1 ? 'Last used yesterday' : `Last used ${days} days ago`;
}

/** Access-summary lines for the consent panel (screen 11). */
export function consentSummary(scopes: readonly Scope[], library: 'none' | 'selected_collections' | 'all', collectionCount: number): string[] {
  const basic = new Set<Scope>(['setup:read', 'preferences:read']);
  const lines: string[] = [];
  if (scopes.every((s) => basic.has(s))) lines.push(scopes.length ? 'Setup and preferences only' : 'Nothing selected yet');
  else {
    const parts: string[] = [];
    if (scopes.includes('setup:read')) parts.push('device setup');
    if (scopes.includes('preferences:read') || scopes.includes('preferences:write')) {
      parts.push(scopes.includes('preferences:write') ? 'ordinary preferences (read and change)' : 'preferences');
    }
    if (scopes.includes('collections:read') && library !== 'none') {
      parts.push(library === 'all' ? 'your entire library' : `${collectionCount} selected ${collectionCount === 1 ? 'collection' : 'collections'}`);
    }
    if (parts.length) lines.push(`${parts[0]!.charAt(0).toUpperCase()}${parts[0]!.slice(1)}${parts.length > 1 ? `, ${parts.slice(1).join(', ')}` : ''}`);
  }
  const media = scopes.some((s) => s.startsWith('media:'));
  const capture = scopes.includes('devices:command');
  if (!media && !capture) lines.push('No media, microphone or camera access');
  else if (!capture) lines.push('Photos and videos only as listed. No microphone or camera access');
  else lines.push('Capture requests only while you allow them on your phone. Microphone stays off');
  return lines;
}

/** Summary heading for the share panel (screen 12). */
export function shareStateTitle(activeLinks: number, members: number, pendingInvites: number, restrictedActive: boolean): string {
  if (activeLinks > 0) return 'Link sharing is on';
  if (restrictedActive && (members > 0 || pendingInvites > 0)) {
    return members > 0 ? `Shared with ${members} ${members === 1 ? 'person' : 'people'}` : 'Invitations pending';
  }
  return 'Currently private';
}

export function formatDuration(ms: number | null): string {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
