/**
 * Outline icons added for the capture platform, drawn in the same family as
 * components/Icon.tsx (20 px grid, 1.75 px stroke, round caps). Decorative by
 * default; controls carry visible text or an aria-label.
 */
const PATHS = {
  home: <path d="M3.5 9 10 3.5 16.5 9v7a.8.8 0 0 1-.8.8H4.3a.8.8 0 0 1-.8-.8z" />,
  library: (
    <>
      <rect x="2.8" y="5.5" width="11.7" height="10.5" rx="1.4" />
      <path d="M5.8 3.2h10.1a1.3 1.3 0 0 1 1.3 1.3v8.6" />
      <path d="m3.4 14.2 3.4-3.4 2.6 2.5 1.6-1.5 3 2.6" />
      <circle cx="10.6" cy="8.6" r="1.1" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.2" y="4.5" width="13.6" height="12" rx="1.6" />
      <path d="M3.2 8.5h13.6M7 2.8v3.4M13 2.8v3.4" />
    </>
  ),
  glasses: (
    <>
      <circle cx="5.6" cy="11" r="3.3" />
      <circle cx="14.4" cy="11" r="3.3" />
      <path d="M8.9 10.6c.7-.6 1.5-.6 2.2 0M2.3 10.2 1.6 8.6M17.7 10.2l.7-1.6" />
    </>
  ),
  mic: (
    <>
      <rect x="7.5" y="2.8" width="5" height="9" rx="2.5" />
      <path d="M4.8 9.6a5.2 5.2 0 0 0 10.4 0M10 14.8v2.6" />
    </>
  ),
  micOff: (
    <>
      <path d="M12.5 8.6V5.3a2.5 2.5 0 0 0-4.6-1.4M7.5 7.8v1.8a2.5 2.5 0 0 0 3.9 2.1" />
      <path d="M4.8 9.6a5.2 5.2 0 0 0 8.4 4.1M15.2 9.6a5 5 0 0 1-.5 2.2M10 14.8v2.6M3 3l14 14" />
    </>
  ),
  flip: (
    <>
      <path d="M3.5 8.2A6.6 6.6 0 0 1 15.2 5.4" />
      <path d="M15.6 2.8v3h-3" />
      <path d="M16.5 11.8A6.6 6.6 0 0 1 4.8 14.6" />
      <path d="M4.4 17.2v-3h3" />
    </>
  ),
  play: (
    <path
      d="M6.5 4.3v11.4a.5.5 0 0 0 .8.4l8.6-5.7a.5.5 0 0 0 0-.8L7.3 3.9a.5.5 0 0 0-.8.4z"
      fill="currentColor"
    />
  ),
  pause: (
    <>
      <rect x="5.5" y="4" width="3" height="12" rx=".6" fill="currentColor" />
      <rect x="11.5" y="4" width="3" height="12" rx=".6" fill="currentColor" />
    </>
  ),
  volume: (
    <>
      <path d="M3.5 7.8h2.6L10 4.6v10.8l-3.9-3.2H3.5z" />
      <path d="M13 7.3a3.6 3.6 0 0 1 0 5.4M15.2 5.2a6.6 6.6 0 0 1 0 9.6" />
    </>
  ),
  volumeOff: (
    <>
      <path d="M3.5 7.8h2.6L10 4.6v10.8l-3.9-3.2H3.5z" />
      <path d="m13 8 4 4M17 8l-4 4" />
    </>
  ),
  fullscreen: <path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" />,
  user: (
    <>
      <circle cx="10" cy="7.2" r="3.2" />
      <path d="M3.8 16.8a6.4 6.4 0 0 1 12.4 0" />
    </>
  ),
  alert: (
    <>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 6v5" />
      <circle cx="10" cy="13.9" r=".5" fill="currentColor" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="10" cy="10" r="7.6" fill="currentColor" stroke="none" />
      <path d="m6.6 10.2 2.3 2.3 4.6-4.8" stroke="var(--canvas)" />
    </>
  ),
  cloudUpload: (
    <>
      <path d="M6.2 15.5H5.5a3.3 3.3 0 0 1-.4-6.6 5 5 0 0 1 9.6-.4 3.6 3.6 0 0 1 .3 7h-1.2" />
      <path d="M10 16.5v-6.2M7.6 12.6 10 10.2l2.4 2.4" />
    </>
  ),
  gear: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M8.6 2.8h2.8l.4 2 1.5.9 1.9-.7 1.4 2.4-1.5 1.4v1.7l1.5 1.4-1.4 2.4-1.9-.7-1.5.9-.4 2H8.6l-.4-2-1.5-.9-1.9.7-1.4-2.4 1.5-1.4V8.8L3.4 7.4l1.4-2.4 1.9.7 1.5-.9z" />
    </>
  ),
  phone: (
    <>
      <rect x="5.5" y="2.5" width="9" height="15" rx="1.8" />
      <path d="M8.8 14.8h2.4" />
    </>
  ),
  link: (
    <>
      <path d="M8.6 11.4a3 3 0 0 0 4.2 0l2.4-2.4a3 3 0 0 0-4.2-4.2l-1 1" />
      <path d="M11.4 8.6a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l1-1" />
    </>
  ),
} as const;

export type V2IconName = keyof typeof PATHS;

export function V2Icon({
  name,
  size = 20,
  className,
  label,
}: {
  name: V2IconName;
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/** Large line drawing of glasses for the unavailable state (reference 09). */
export function GlassesArt({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 160 64"
      width="160"
      height="64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 10c18-4 44-4 62 0 2 1 3 3 3 5 0 18-8 38-34 38C10 53 5 32 4 16z" />
      <path d="M156 10c-18-4-44-4-62 0-2 1-3 3-3 5 0 18 8 38 34 38 25 0 30-21 31-37z" />
      <path d="M8 14c15-3 40-3 55 0 1 1 2 2 2 4 0 15-7 31-30 31C13 49 9 31 8 18z" opacity=".55" />
      <path
        d="M152 14c-15-3-40-3-55 0-1 1-2 2-2 4 0 15 7 31 30 31 22 0 26-18 27-31z"
        opacity=".55"
      />
      <path d="M69 15c4-3 18-3 22 0" />
      <circle cx="10" cy="15" r="1.6" />
      <circle cx="150" cy="15" r="1.6" />
      <path d="M22 24l6 14M138 24l-6 14" opacity=".55" />
    </svg>
  );
}
