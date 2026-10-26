/**
 * One outline icon family: 20 px, 1.75 px stroke, round caps and joins
 * (DESIGN-GUIDE "Visual system"). Decorative by default (aria-hidden); controls
 * always carry a visible text label or an aria-label.
 */
const PATHS = {
  plus: <path d="M10 4v12M4 10h12" />,
  camera: (
    <>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h2l1.2-1.8A1 1 0 0 1 8.5 3.8h3a1 1 0 0 1 .8.4L13.5 6h2A1.5 1.5 0 0 1 17 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z" />
      <circle cx="10" cy="10.8" r="2.8" />
    </>
  ),
  upload: (
    <>
      <path d="M10 13V4M6.5 7.5 10 4l3.5 3.5" />
      <path d="M4 12.5v2A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <circle cx="7.5" cy="8.5" r="1.3" />
      <path d="m3.5 14.5 4-4 3 3 2-2 4 3.5" />
    </>
  ),
  bookmark: <path d="M6 3.5h8a.5.5 0 0 1 .5.5v12.5L10 13l-4.5 3.5V4a.5.5 0 0 1 .5-.5z" />,
  bookmarkFilled: (
    <path
      d="M6 3.5h8a.5.5 0 0 1 .5.5v12.5L10 13l-4.5 3.5V4a.5.5 0 0 1 .5-.5z"
      fill="currentColor"
    />
  ),
  arrowLeft: <path d="M16 10H4m5-5-5 5 5 5" />,
  arrowRight: <path d="M4 10h12m-5-5 5 5-5 5" />,
  external: (
    <>
      <path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V12" />
      <path d="M11 4h5v5M16 4l-7 7" />
    </>
  ),
  chevronDown: <path d="m5 7.5 5 5 5-5" />,
  chevronRight: <path d="m7.5 5 5 5-5 5" />,
  chevronLeft: <path d="m12.5 5-5 5 5 5" />,
  close: <path d="M5 5l10 10M15 5 5 15" />,
  check: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  collection: (
    <>
      <rect x="4" y="6.5" width="12" height="10" rx="1.5" />
      <path d="M6 4h8" />
    </>
  ),
  plan: <path d="m3.5 5.5 4-1.8 5 1.8 4-1.8v10.8l-4 1.8-5-1.8-4 1.8zM7.5 3.7v10.8M12.5 5.5v10.8" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="m12.8 12.8 3.7 3.7" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="10" r="1" fill="currentColor" />
      <circle cx="10" cy="10" r="1" fill="currentColor" />
      <circle cx="15" cy="10" r="1" fill="currentColor" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </>
  ),
  refresh: (
    <>
      <path d="M15.5 9.5A5.5 5.5 0 1 1 14 5.6" />
      <path d="M14.5 2.8v3.4h-3.4" />
    </>
  ),
  crop: <path d="M6 2.5V14h11.5M2.5 6H14v11.5" />,
  /** Style reading: highlight where a detail is in the photo. */
  locate: (
    <>
      <circle cx="10" cy="10" r="5.5" />
      <circle cx="10" cy="10" r="1.5" />
      <path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.5" />
      <path d="M13 4.5V4A1.5 1.5 0 0 0 11.5 2.5h-7A1.5 1.5 0 0 0 3 4v7a1.5 1.5 0 0 0 1.5 1.5H5" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 20,
  className,
  label,
}: {
  name: IconName;
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
      strokeWidth={1.75}
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
