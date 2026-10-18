/**
 * Exact recurring copy from specs/capture-platform-v2/design/copy.json.
 * copy.test.ts fails if this drifts from the design package.
 */
export const COPY = {
  'capture.title': 'Keep what catches your eye.',
  'capture.camera': 'This camera',
  'capture.glasses': 'Meta glasses',
  'capture.experimental': 'Experimental',
  'capture.upload': 'Upload files',
  'capture.private': 'Your library is private. Choose what to explore.',
  'upload.notice': 'Uploading does not start analysis.',
  'video.analysis': 'We explore selected moments, not every frame.',
  'glasses.unavailable':
    'Glasses capture is not enabled for this app release. Your camera and uploads are ready to use.',
  'agents.title': 'Connected agents',
  'agents.subtitle': 'Choose what each agent can see and do.',
  'agents.remote': 'Request capture while I allow it',
  'agents.remote_notice': 'Capture also requires permission on your phone.',
  'shares.restricted': 'Restricted',
  'shares.link': 'Anyone with the link',
  'shares.notice': 'Anyone with this link can view the items you include.',
  'shares.live': 'New items added to this collection follow these sharing settings.',
  'shares.media': 'Include captured photos and videos',
  'shares.download': 'Allow original downloads',
  'shares.revoked': 'This collection is no longer shared.',
  // Spec amendment 2.2 (screens 14-18).
  'onboarding.images.title': 'Pick what catches your eye.',
  'onboarding.chips.title': 'Choose a few favorites.',
  'onboarding.group.wear': 'Wear',
  'onboarding.group.play': 'Play',
  'onboarding.group.watch': 'Watch',
  'onboarding.group.eat': 'Eat',
  'onboarding.search.placeholder': 'Add an artist, film, brand or place',
  'onboarding.search.unavailable': 'Search is taking a break. Pick from the ideas above.',
  'onboarding.exclusions.title': 'Anything to leave out?',
  'onboarding.counter.3': '3 picks to go',
  'onboarding.counter.2': '2 picks to go',
  'onboarding.counter.1': '1 pick to go',
  'onboarding.counter.ready': 'Ready',
  'onboarding.primary': 'Build my feed',
  'onboarding.primary_disabled': 'Pick at least 3 so your feed starts with you.',
  'onboarding.back': 'Back',
  'building.title': 'Building your feed…',
  'building.unavailable': "We'll keep building in the background.",
  'while_we_look.title': 'While we look',
  'while_we_look.collapsed': 'More to explore',
  'ready.toast': 'Your photo is ready',
  'ready.open': 'Open',
  'settings_taste.title': 'Taste',
} as const;

/** SCREEN-CONTRACT "Visual review corrections" replace these raw mockup strings. */
export const CORRECTIONS = {
  /** Reference 05: replaces the browser-only remote-capture description. */
  remoteCapture: 'Allow selected devices and agents to request capture for 10 minutes',
  /** Reference 03: shown until a recording is finalized. */
  recording: 'Recording on this phone',
  /** Reference 08: replaces "All active". */
  allFilter: 'All',
} as const;
