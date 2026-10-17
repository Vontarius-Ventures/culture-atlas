/**
 * Original illustrations for the capture platform v2 surfaces, drawn in code
 * (SVG rendered to JPEG with sharp) like generate-illustrations.ts. No mockup
 * pixels, third-party photos, likenesses of real people or real logos.
 *
 *   pnpm exec tsx fixtures/images/generate-capture-illustrations.ts
 *
 * Output:
 *  - apps/web/public/capture/source-hero.jpg   (02 capture chooser hero)
 *  - apps/web/public/capture/glasses-hero.jpg  (04 glasses connect hero)
 *  - fixtures/capture-v2/*.jpg                  (seed media for the library,
 *    uploads and video detail; uploaded through the real API by
 *    apps/web/e2e/real/v2-fidelity.spec.ts, never shipped in the UI)
 *
 * Deterministic: re-running produces identical files. Licenses in
 * fixtures/images/LICENSES.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'packages/domain/package.json'));
type Sharp = (input: Buffer) => {
  jpeg(options: { quality: number; mozjpeg: boolean }): { toBuffer(): Promise<Buffer> };
};
const sharp = require('sharp') as Sharp;

const W = 1600;
const H = 1200;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Shared lighting, vignette and grain so every scene reads as one set. */
function frame(
  body: string,
  opts: {
    light?: [number, number];
    warmth?: string;
    vignette?: number;
    w?: number;
    h?: number;
  } = {},
) {
  const w = opts.w ?? W;
  const h = opts.h ?? H;
  const [lx, ly] = opts.light ?? [0.3, 0.2];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="11" result="n"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.45  0 0 0 0 0.4  0 0 0 0.08 0"/>
    </filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="16"/></filter>
    <filter id="softer" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
    <filter id="blur4" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="blur10" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter>
    <radialGradient id="vig" cx="0.5" cy="0.5" r="0.78">
      <stop offset="0.6" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="${opts.vignette ?? 0.35}"/>
    </radialGradient>
    <radialGradient id="light" cx="${lx}" cy="${ly}" r="0.85">
      <stop offset="0" stop-color="${opts.warmth ?? '#ffdcaa'}" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#ffdcaa" stop-opacity="0"/>
    </radialGradient>
  </defs>
  ${body}
  <rect width="${w}" height="${h}" fill="url(#light)"/>
  <rect width="${w}" height="${h}" fill="url(#vig)"/>
  <rect width="${w}" height="${h}" filter="url(#grain)"/>
</svg>`;
}

/** Wood planks with grain lines, from y0 to the bottom. */
function woodTable(y0: number, seed: number, tone = ['#a8743f', '#7a4f2a']) {
  const r = rng(seed);
  const lines = Array.from({ length: 70 }, () => {
    const y = y0 + r() * (H - y0);
    const x = r() * W;
    const len = 200 + r() * 600;
    return `<path d="M${x.toFixed(0)} ${y.toFixed(0)} q${(len / 2).toFixed(0)} ${(r() * 8 - 4).toFixed(1)} ${len.toFixed(0)} 0" stroke="#5a371c" stroke-opacity="${(0.12 + r() * 0.2).toFixed(2)}" stroke-width="${(1 + r() * 2.5).toFixed(1)}" fill="none"/>`;
  }).join('');
  return `<defs><linearGradient id="wood${seed}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone[0]}"/><stop offset="1" stop-color="${tone[1]}"/></linearGradient></defs>
    <rect x="0" y="${y0}" width="${W}" height="${H - y0}" fill="url(#wood${seed})"/>${lines}`;
}

/** Dappled leaf shadows across a surface. */
function leafShadows(seed: number, area: [number, number, number, number], opacity = 0.22) {
  const r = rng(seed);
  const [x0, y0, w, h] = area;
  return `<g opacity="${opacity}" filter="url(#blur10)">${Array.from({ length: 46 }, () => {
    const x = x0 + r() * w;
    const y = y0 + r() * h;
    return `<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(14 + r() * 40).toFixed(0)}" ry="${(6 + r() * 14).toFixed(0)}" transform="rotate(${(r() * 180).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})" fill="#2a1a0e"/>`;
  }).join('')}</g>`;
}

/** Speckled glaze dots inside a clip path. */
function speckle(seed: number, clip: string, box: [number, number, number, number], n = 160) {
  const r = rng(seed);
  const [x0, y0, w, h] = box;
  return `<g clip-path="url(#${clip})">${Array.from(
    { length: n },
    () =>
      `<circle cx="${(x0 + r() * w).toFixed(0)}" cy="${(y0 + r() * h).toFixed(0)}" r="${(1 + r() * 2.4).toFixed(1)}" fill="#6b5440" opacity="${(0.25 + r() * 0.45).toFixed(2)}"/>`,
  ).join('')}</g>`;
}

/** Olive sprig: a stem with narrow leaves. */
function olive(x: number, y: number, len: number, angle: number, seed: number, color = '#4f5a32') {
  const r = rng(seed);
  const leaves = Array.from({ length: 12 }, (_, i) => {
    const t = (i + 1) / 13;
    const lx = x + Math.cos((angle * Math.PI) / 180) * len * t;
    const ly = y + Math.sin((angle * Math.PI) / 180) * len * t;
    const side = i % 2 ? 1 : -1;
    const a = angle + side * (35 + r() * 25);
    return `<ellipse cx="${(lx + Math.cos((a * Math.PI) / 180) * 30).toFixed(0)}" cy="${(ly + Math.sin((a * Math.PI) / 180) * 30).toFixed(0)}" rx="36" ry="8" transform="rotate(${a.toFixed(0)} ${(lx + Math.cos((a * Math.PI) / 180) * 30).toFixed(0)} ${(ly + Math.sin((a * Math.PI) / 180) * 30).toFixed(0)})" fill="${color}" opacity="${(0.75 + r() * 0.25).toFixed(2)}"/>`;
  }).join('');
  return `<path d="M${x} ${y} l${(Math.cos((angle * Math.PI) / 180) * len).toFixed(0)} ${(Math.sin((angle * Math.PI) / 180) * len).toFixed(0)}" stroke="#4a3b26" stroke-width="5"/>${leaves}`;
}

const scenes: Record<string, () => string> = {
  // 02 hero / "Made by hand" / pottery.jpg: stoneware bowls, a speckled pitcher
  // and a plate on an oak table in low sun, olive sprigs in a glass behind.
  'capture/source-hero': () =>
    frame(
      `<defs>
        <linearGradient id="wallA" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8f7c66"/><stop offset="0.55" stop-color="#b9a68c"/><stop offset="1" stop-color="#d8c8ae"/></linearGradient>
        <radialGradient id="glazeA" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#efe6d6"/><stop offset="0.7" stop-color="#d4c6ad"/><stop offset="1" stop-color="#a99579"/></radialGradient>
        <linearGradient id="rimA" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8a6a48"/><stop offset="1" stop-color="#b18b62"/></linearGradient>
        <linearGradient id="glassA" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#cfd6c8" stop-opacity="0.35"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.15"/><stop offset="1" stop-color="#cfd6c8" stop-opacity="0.4"/></linearGradient>
        <clipPath id="pitcherA"><path d="M880 470 Q850 420 900 400 L1090 400 Q1120 420 1100 470 Q1180 600 1150 760 Q1130 850 990 860 Q850 850 830 760 Q800 600 880 470 Z"/></clipPath>
        <clipPath id="bowlA"><path d="M120 640 Q370 600 600 640 Q590 820 360 840 Q140 820 120 640 Z"/></clipPath>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#wallA)"/>
      <rect x="1180" y="60" width="380" height="250" rx="6" fill="#7c6a54" opacity="0.55"/>
      <rect x="1196" y="76" width="348" height="218" fill="#a8977d" opacity="0.6"/>
      ${woodTable(560, 5)}
      <g fill="#5d3c22"><rect x="1300" y="300" width="36" height="420" rx="8"/><rect x="1500" y="300" width="36" height="420" rx="8"/><rect x="1280" y="290" width="290" height="40" rx="14"/><rect x="1380" y="330" width="22" height="300" opacity="0.8"/><rect x="1440" y="330" width="22" height="300" opacity="0.8"/></g>
      ${leafShadows(7, [600, 560, 1000, 640], 0.32)}
      <rect x="160" y="300" width="150" height="300" rx="20" fill="url(#glassA)" stroke="#e8ece2" stroke-opacity="0.5" stroke-width="4"/>
      <rect x="168" y="460" width="134" height="132" rx="14" fill="#c8d0bf" opacity="0.25"/>
      ${olive(230, 320, 330, -120, 3)}${olive(240, 320, 380, -70, 4)}${olive(220, 330, 300, -150, 9)}${olive(250, 330, 260, -30, 12)}
      ${(() => {
        const r = rng(25);
        return Array.from(
          { length: 40 },
          () =>
            `<circle cx="${(60 + r() * 420).toFixed(0)}" cy="${(30 + r() * 230).toFixed(0)}" r="${(4 + r() * 5).toFixed(1)}" fill="#f1ead2" opacity="0.9"/>`,
        ).join('');
      })()}
      <ellipse cx="370" cy="830" rx="280" ry="46" fill="#2d1a0d" opacity="0.35" filter="url(#blur10)"/>
      <path d="M120 640 Q370 600 600 640 Q590 820 360 840 Q140 820 120 640 Z" fill="url(#glazeA)"/>
      ${speckle(21, 'bowlA', [120, 600, 480, 240])}
      <ellipse cx="360" cy="640" rx="240" ry="40" fill="#cdbb9f" stroke="url(#rimA)" stroke-width="10"/>
      <path d="M140 560 Q370 525 580 560 Q575 660 360 676 Q150 660 140 560 Z" fill="url(#glazeA)"/>
      <ellipse cx="360" cy="560" rx="220" ry="36" fill="#bfae92" stroke="url(#rimA)" stroke-width="10"/>
      <ellipse cx="360" cy="566" rx="180" ry="24" fill="#a8977c" opacity="0.6"/>
      <ellipse cx="990" cy="860" rx="190" ry="40" fill="#2d1a0d" opacity="0.4" filter="url(#blur10)"/>
      <path d="M880 470 Q850 420 900 400 L1090 400 Q1120 420 1100 470 Q1180 600 1150 760 Q1130 850 990 860 Q850 850 830 760 Q800 600 880 470 Z" fill="url(#glazeA)"/>
      ${speckle(23, 'pitcherA', [820, 390, 360, 480], 260)}
      <path d="M880 410 Q860 380 840 372 Q880 360 905 395 Z" fill="#d8ccb6"/>
      <ellipse cx="995" cy="405" rx="100" ry="18" fill="#c4b393" stroke="#9b8466" stroke-width="5"/>
      <path d="M1120 480 Q1240 470 1230 580 Q1220 680 1140 700" stroke="#d4c6ad" stroke-width="34" fill="none" stroke-linecap="round"/>
      <path d="M1120 480 Q1240 470 1230 580 Q1220 680 1140 700" stroke="#a9967a" stroke-width="6" fill="none" opacity="0.5"/>
      <ellipse cx="760" cy="1010" rx="330" ry="80" fill="#2d1a0d" opacity="0.35" filter="url(#blur10)"/>
      <ellipse cx="760" cy="980" rx="330" ry="86" fill="url(#glazeA)" stroke="url(#rimA)" stroke-width="10"/>
      <ellipse cx="760" cy="975" rx="250" ry="58" fill="#d9ccb4"/>
      ${leafShadows(8, [500, 880, 520, 160], 0.28)}`,
      { light: [0.7, 0.15], vignette: 0.32 },
    ),

  // 04 hero: black glasses on a linen cloth, a stoneware bowl with an olive
  // sprig behind and the corner of a book.
  'capture/glasses-hero': () =>
    frame(
      `<defs>
        <linearGradient id="linenB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9ccb6"/><stop offset="1" stop-color="#c9b89c"/></linearGradient>
        <pattern id="weaveB" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="none"/><path d="M0 4 H8 M4 0 V8" stroke="#a8977c" stroke-opacity="0.07" stroke-width="1"/></pattern>
        <radialGradient id="bowlB" cx="0.4" cy="0.3" r="0.9"><stop offset="0" stop-color="#d9cfbf"/><stop offset="1" stop-color="#9c8d78"/></radialGradient>
        <linearGradient id="frameB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e1d1c"/><stop offset="1" stop-color="#050505"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="#8d8273"/>
      <rect y="250" width="${W}" height="${H - 250}" fill="url(#linenB)"/>
      <rect y="250" width="${W}" height="${H - 250}" fill="url(#weaveB)"/>
      ${Array.from({ length: 14 }, (_, i) => `<path d="M${-100 + i * 140} 260 Q${i * 140} ${600 + (i % 3) * 60} ${40 + i * 140} ${H}" stroke="#b5a487" stroke-width="${10 + (i % 4) * 6}" opacity="0.25" fill="none" filter="url(#blur10)"/>`).join('')}
      <path d="M0 250 Q400 230 800 260 T1600 250" stroke="#b9a88d" stroke-width="18" fill="none" opacity="0.5" filter="url(#blur4)"/>
      ${leafShadows(31, [900, 300, 700, 500], 0.18)}
      <g transform="translate(1180 330) rotate(-6)"><rect width="480" height="150" rx="6" fill="#efe6d4"/><rect y="0" width="480" height="24" fill="#d8cab0"/><path d="M0 40 H480 M0 60 H480 M0 80 H480 M0 100 H480 M0 120 H480" stroke="#cbbca2" stroke-width="3"/><rect y="138" width="480" height="20" rx="4" fill="#c2ae8c"/></g>
      <ellipse cx="170" cy="300" rx="260" ry="70" fill="#5f5446" opacity="0.4" filter="url(#blur10)"/>
      <path d="M-60 180 Q170 140 400 180 Q390 330 170 345 Q-50 330 -60 180 Z" fill="url(#bowlB)"/>
      <ellipse cx="170" cy="180" rx="230" ry="44" fill="#b8a993"/>
      ${olive(240, 170, 360, -25, 41, '#3f4a2b')}${olive(230, 175, 300, -60, 42, '#46522f')}${olive(250, 180, 280, 10, 43, '#3f4a2b')}
      <ellipse cx="800" cy="880" rx="560" ry="90" fill="#3d3226" opacity="0.32" filter="url(#softer)"/>
      <g transform="translate(260 560)">
        <path d="M720 40 L1060 -10 L1072 8 L760 70 Z" fill="url(#frameB)"/>
        <path d="M1060 -10 Q1110 -16 1120 30 L1104 40 Q1096 10 1066 12 Z" fill="#1a1a1a"/>
        <path d="M30 70 Q30 30 80 26 L410 20 Q470 22 470 80 Q470 230 410 280 Q330 330 170 320 Q60 312 40 220 Z" fill="none" stroke="url(#frameB)" stroke-width="44" stroke-linejoin="round"/>
        <path d="M560 60 Q560 24 610 22 L900 30 Q950 36 948 90 Q940 230 880 280 Q810 330 680 320 Q580 310 566 220 Z" fill="none" stroke="url(#frameB)" stroke-width="44" stroke-linejoin="round"/>
        <path d="M470 70 Q515 44 560 66" stroke="#1d1d1d" stroke-width="36" fill="none"/>
        <path d="M60 60 Q200 40 400 46" stroke="#5c5a57" stroke-width="5" fill="none" opacity="0.6"/>
        <path d="M590 56 Q760 48 920 62" stroke="#5c5a57" stroke-width="5" fill="none" opacity="0.6"/>
        <circle cx="34" cy="70" r="14" fill="#2b2b2b" stroke="#5a5856" stroke-width="3"/>
        <circle cx="938" cy="76" r="13" fill="#2b2b2b" stroke="#5a5856" stroke-width="3"/>
        <path d="M30 70 Q30 30 80 26 L410 20 Q470 22 470 80 Q470 230 410 280 Q330 330 170 320 Q60 312 40 220 Z" fill="#f4ede0" opacity="0.08"/>
        <path d="M560 60 Q560 24 610 22 L900 30 Q950 36 948 90 Q940 230 880 280 Q810 330 680 320 Q580 310 566 220 Z" fill="#f4ede0" opacity="0.08"/>
        <path d="M120 80 L180 250 M640 80 L700 240" stroke="#ffffff" stroke-width="10" opacity="0.12"/>
      </g>`,
      { light: [0.6, 0.25], vignette: 0.3 },
    ),

  // "Along the coast": headland, surf and a sandy beach in clear afternoon light.
  'capture-v2/along-the-coast': () =>
    frame(
      `<defs>
        <linearGradient id="skyC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b9c6cc"/><stop offset="1" stop-color="#e3e0d6"/></linearGradient>
        <linearGradient id="seaC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b7480"/><stop offset="1" stop-color="#8ea3a6"/></linearGradient>
        <linearGradient id="sandC" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cdbb9b"/><stop offset="1" stop-color="#b19c78"/></linearGradient>
        <linearGradient id="cliffC" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9a7d5c"/><stop offset="1" stop-color="#5c4632"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#skyC)"/>
      <path d="M0 420 Q260 380 520 410 L620 430 L0 440 Z" fill="#8d958f" opacity="0.6"/>
      <rect y="430" width="${W}" height="360" fill="url(#seaC)"/>
      <path d="M760 430 Q900 300 1080 270 Q1260 240 1400 300 Q1520 340 1600 330 L1600 820 Q1400 760 1220 640 Q1050 520 760 430 Z" fill="url(#cliffC)"/>
      <path d="M900 380 Q1100 330 1300 360 M1000 450 Q1200 420 1420 470 M1150 560 Q1300 540 1500 600" stroke="#4a3828" stroke-width="10" opacity="0.4" fill="none"/>
      <path d="M1180 300 Q1300 260 1440 310 Q1540 330 1600 320 L1600 360 Q1450 350 1300 330 Z" fill="#6e7a4b" opacity="0.8"/>
      ${Array.from({ length: 9 }, (_, i) => `<path d="M0 ${560 + i * 34} Q400 ${540 + i * 34} 800 ${565 + i * 36} T1500 ${640 + i * 40}" stroke="#f4f1ea" stroke-width="${3 + (i % 3) * 3}" opacity="${0.35 + (i % 2) * 0.25}" fill="none"/>`).join('')}
      <path d="M0 780 Q500 720 1000 760 Q1300 790 1600 840 L1600 ${H} L0 ${H} Z" fill="url(#sandC)"/>
      <path d="M0 790 Q500 735 1000 772 Q1300 800 1600 850" stroke="#f6f2e8" stroke-width="14" opacity="0.7" fill="none"/>
      <path d="M0 810 Q500 760 1000 795 Q1300 820 1600 870" stroke="#7d8f8c" stroke-width="10" opacity="0.35" fill="none"/>
      ${(() => {
        const r = rng(71);
        return Array.from(
          { length: 30 },
          () =>
            `<ellipse cx="${(200 + r() * 1200).toFixed(0)}" cy="${(880 + r() * 280).toFixed(0)}" rx="${(4 + r() * 8).toFixed(0)}" ry="3" fill="#8d7656" opacity="0.4"/>`,
        ).join('');
      })()}`,
      { light: [0.75, 0.2], warmth: '#fff0d0', vignette: 0.25 },
    ),

  // "Olive layers": an olive field jacket on a wall hook beside a canvas tote.
  'capture-v2/olive-layers': () =>
    frame(
      `<defs>
        <linearGradient id="wallD" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e8e1d4"/><stop offset="1" stop-color="#c9bea9"/></linearGradient>
        <linearGradient id="jacketD" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6e7547"/><stop offset="0.6" stop-color="#4f5633"/><stop offset="1" stop-color="#363b23"/></linearGradient>
        <linearGradient id="toteD" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ece2cf"/><stop offset="1" stop-color="#c8b99c"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#wallD)"/>
      ${leafShadows(81, [0, 0, 700, 1200], 0.16)}
      <rect x="380" y="140" width="820" height="48" rx="8" fill="#8a6440"/>
      <circle cx="560" cy="200" r="16" fill="#5b4028"/><circle cx="1020" cy="200" r="16" fill="#5b4028"/>
      <path d="M560 200 Q480 260 470 330 L340 420 Q260 700 300 1080 L470 1100 L480 760 L520 1120 L800 1120 L790 700 L760 330 Q680 250 560 200 Z" fill="url(#jacketD)"/>
      <path d="M560 200 Q610 300 640 520 L660 1120" stroke="#2f3420" stroke-width="6" fill="none"/>
      <path d="M470 330 Q560 300 560 200 Q600 300 760 330" fill="#59603a"/>
      <rect x="380" y="620" width="140" height="120" rx="10" fill="#4a5130" stroke="#353a22" stroke-width="5"/>
      <rect x="640" y="620" width="130" height="120" rx="10" fill="#4a5130" stroke="#353a22" stroke-width="5"/>
      <g fill="#2c2f1c">${[420, 520, 620, 720, 820, 920].map((y) => `<circle cx="660" cy="${y}" r="9"/>`).join('')}</g>
      <path d="M330 440 Q300 700 330 1060" stroke="#353a22" stroke-width="8" fill="none" opacity="0.5"/>
      <path d="M1020 200 Q960 300 950 420 M1020 200 Q1080 300 1100 420" stroke="#c4b496" stroke-width="16" fill="none"/>
      <path d="M900 420 L1160 420 L1200 980 Q1050 1010 880 980 Z" fill="url(#toteD)"/>
      <path d="M900 420 L1160 420" stroke="#b3a283" stroke-width="10"/>
      ${leafShadows(83, [880, 420, 320, 560], 0.16)}`,
      { light: [0.15, 0.1], vignette: 0.28 },
    ),

  // "Afternoon walk": brick row houses, tall windows, railings and tree shade.
  'capture-v2/afternoon-walk': () =>
    frame(
      `<defs>
        <pattern id="brickE" width="80" height="40" patternUnits="userSpaceOnUse"><rect width="80" height="40" fill="#9a4f36"/><path d="M0 0 H80 M0 20 H80 M40 0 V20 M0 20 V40 M80 20 V40" stroke="#d8b9a0" stroke-opacity="0.45" stroke-width="3"/></pattern>
        <linearGradient id="skyE" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfd7d2"/><stop offset="1" stop-color="#e8e2d2"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#skyE)"/>
      <rect x="120" y="0" width="1080" height="${H}" fill="url(#brickE)"/>
      <rect x="120" y="0" width="1080" height="${H}" fill="#6b2f1e" opacity="0.15"/>
      ${[260, 640].map((x) => `<g><rect x="${x}" y="80" width="230" height="400" fill="#1f2421"/><rect x="${x + 14}" y="94" width="202" height="372" fill="#2c3430"/><path d="M${x + 115} 94 V466 M${x + 14} 280 H${x + 216}" stroke="#d9d3c2" stroke-width="10"/><rect x="${x - 16}" y="480" width="262" height="24" fill="#c9bba2"/></g>`).join('')}
      ${[260, 640].map((x) => `<g><rect x="${x}" y="620" width="230" height="360" fill="#1f2421"/><rect x="${x + 14}" y="634" width="202" height="332" fill="#2c3430"/><path d="M${x + 115} 634 V966 M${x + 14} 800 H${x + 216}" stroke="#d9d3c2" stroke-width="10"/></g>`).join('')}
      <rect x="980" y="560" width="190" height="640" fill="#24302a"/><rect x="996" y="580" width="158" height="600" fill="#33443a"/>
      <g stroke="#1b1b1b" stroke-width="7">${Array.from({ length: 30 }, (_, i) => `<path d="M${120 + i * 36} 1030 V1200"/>`).join('')}<path d="M120 1040 H1200 M120 1180 H1200"/></g>
      ${leafShadows(91, [120, 0, 1080, 1200], 0.42)}
      <rect x="1200" y="0" width="400" height="${H}" fill="#7f8c66"/>
      <g opacity="0.9">${(() => {
        const r = rng(95);
        return Array.from(
          { length: 70 },
          () =>
            `<circle cx="${(1180 + r() * 440).toFixed(0)}" cy="${(r() * 900).toFixed(0)}" r="${(30 + r() * 60).toFixed(0)}" fill="${r() > 0.5 ? '#5d6e3e' : '#8a9a5b'}" opacity="0.8"/>`,
        ).join('');
      })()}</g>
      <rect x="1360" y="600" width="44" height="600" fill="#4b3a2a"/>`,
      { light: [0.85, 0.15], warmth: '#ffd690', vignette: 0.3 },
    ),

  // "Green spaces": white hydrangeas and a bistro chair in a courtyard.
  'capture-v2/green-spaces': () =>
    frame(
      `<defs>
        <linearGradient id="wallF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9d0bd"/><stop offset="1" stop-color="#b9ad95"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#wallF)"/>
      <g opacity="0.5">${Array.from({ length: 12 }, (_, i) => `<rect x="${(i % 4) * 400 + (Math.floor(i / 4) % 2) * 200}" y="${Math.floor(i / 4) * 140}" width="380" height="130" fill="#cfc4ad" stroke="#b3a68c" stroke-width="4"/>`).join('')}</g>
      <rect x="1100" y="60" width="380" height="460" fill="#2d3a2c"/><rect x="1116" y="76" width="348" height="428" fill="#3f5240"/>
      <rect y="800" width="${W}" height="400" fill="#cbbfa6"/>
      <g opacity="0.95">${(() => {
        const r = rng(101);
        return Array.from({ length: 150 }, () => {
          const x = r() * 1100;
          const y = 380 + r() * 820;
          return `<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(26 + r() * 30).toFixed(0)}" ry="${(14 + r() * 14).toFixed(0)}" transform="rotate(${(r() * 180).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})" fill="${r() > 0.5 ? '#3e5a2c' : '#5a7a3a'}"/>`;
        }).join('');
      })()}</g>
      ${(() => {
        const r = rng(103);
        const heads: Array<[number, number, number]> = [
          [180, 520, 110],
          [420, 460, 120],
          [660, 560, 100],
          [300, 760, 120],
          [560, 820, 110],
          [860, 700, 100],
          [120, 960, 100],
          [780, 980, 110],
          [980, 520, 90],
        ];
        return heads
          .map(([cx, cy, rad]) =>
            Array.from({ length: 70 }, () => {
              const a = r() * Math.PI * 2;
              const d = Math.sqrt(r()) * rad;
              return `<circle cx="${(cx + Math.cos(a) * d).toFixed(0)}" cy="${(cy + Math.sin(a) * d * 0.85).toFixed(0)}" r="${(9 + r() * 7).toFixed(0)}" fill="${r() > 0.3 ? '#f4f1e2' : '#dfe3c6'}" stroke="#c9ccae" stroke-width="1.5"/>`;
            }).join(''),
          )
          .join('');
      })()}
      <g stroke="#55704a" stroke-width="12" fill="none" stroke-linecap="round"><path d="M1240 640 V1060 M1440 640 V1060 M1220 830 H1460 M1240 640 Q1340 600 1440 640"/><path d="M1260 690 V830 M1300 680 V830 M1340 676 V830 M1380 680 V830 M1420 690 V830"/><path d="M1230 1060 L1200 1180 M1450 1060 L1480 1180"/></g>
      <ellipse cx="1340" cy="1170" rx="200" ry="20" fill="#5b4a33" opacity="0.3" filter="url(#blur10)"/>`,
      { light: [0.7, 0.2], vignette: 0.3 },
    ),

  // "Quiet corners": a leather armchair by a window, a plant and a rug.
  'capture-v2/quiet-corners': () =>
    frame(
      `<defs>
        <linearGradient id="wallG" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#cbbca3"/><stop offset="1" stop-color="#e8dfcd"/></linearGradient>
        <linearGradient id="leatherG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8c5a33"/><stop offset="1" stop-color="#5a3519"/></linearGradient>
        <linearGradient id="floorG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b6744"/><stop offset="1" stop-color="#5e4229"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#wallG)"/>
      <rect x="1120" y="80" width="420" height="640" fill="#f3efe2"/>
      <g fill="#b8c8a2" opacity="0.8">${Array.from({ length: 12 }, (_, i) => `<circle cx="${1180 + (i % 4) * 100}" cy="${160 + Math.floor(i / 4) * 160}" r="70"/>`).join('')}</g>
      <path d="M1120 80 H1540 V720 H1120 Z M1330 80 V720 M1120 400 H1540" stroke="#ece5d3" stroke-width="22" fill="none"/>
      <rect x="560" y="140" width="220" height="260" fill="#5d4630"/><rect x="576" y="156" width="188" height="228" fill="#a69378"/>
      <rect y="900" width="${W}" height="300" fill="url(#floorG)"/>
      <ellipse cx="760" cy="1050" rx="640" ry="120" fill="#c8b597" opacity="0.85"/>
      <path d="M1100 720 L1500 720 L1620 1200 L900 1200 Z" fill="#f7e6c2" opacity="0.25"/>
      <rect x="140" y="560" width="160" height="40" rx="6" fill="#7a5532"/><rect x="160" y="600" width="18" height="360" fill="#5b3c22"/><rect x="262" y="600" width="18" height="360" fill="#5b3c22"/>
      <rect x="150" y="530" width="140" height="30" fill="#e6dccb"/><rect x="160" y="506" width="120" height="24" fill="#b39a73"/>
      <path d="M220 500 Q160 300 120 220 M220 500 Q240 320 300 200 M220 500 Q300 380 380 330" stroke="#4d5a33" stroke-width="8" fill="none"/>
      <g fill="#58693a">${[
        [120, 220],
        [300, 200],
        [380, 330],
        [170, 320],
        [260, 290],
        [330, 260],
      ]
        .map(
          ([x, y]) =>
            `<ellipse cx="${x}" cy="${y}" rx="60" ry="22" transform="rotate(-30 ${x} ${y})"/>`,
        )
        .join('')}</g>
      <rect x="500" y="520" width="560" height="300" rx="40" fill="url(#leatherG)"/>
      <rect x="560" y="420" width="440" height="260" rx="40" fill="#7e4f2c"/>
      <path d="M600 470 H960 M600 560 H960" stroke="#5b3519" stroke-width="5" opacity="0.6"/>
      <rect x="520" y="700" width="520" height="110" rx="30" fill="#8f5d35"/>
      <rect x="440" y="560" width="80" height="260" rx="16" fill="#6b4224"/><rect x="1040" y="560" width="80" height="260" rx="16" fill="#6b4224"/>
      <path d="M470 820 L430 1000 M1090 820 L1130 1000 M640 820 L630 960 M920 820 L930 960" stroke="#4a2c15" stroke-width="20" stroke-linecap="round"/>
      <ellipse cx="780" cy="1000" rx="380" ry="40" fill="#2e1c0e" opacity="0.3" filter="url(#blur10)"/>`,
      { light: [0.85, 0.25], vignette: 0.3 },
    ),

  // "A slower afternoon" video: a café interior with window light...
  'capture-v2/cafe-interior': () =>
    frame(
      `<defs>
        <linearGradient id="wallH" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b2d22"/><stop offset="1" stop-color="#6e5a46"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#wallH)"/>
      ${[80, 360, 640].map((x) => `<rect x="${x}" y="60" width="240" height="640" fill="#e7dcc0"/><g fill="#7f925a" opacity="0.75">${Array.from({ length: 8 }, (_, i) => `<circle cx="${x + 30 + (i % 3) * 90}" cy="${120 + i * 70}" r="${50 + (i % 2) * 20}"/>`).join('')}</g>`).join('')}
      <path d="M80 60 H880 V700 H80 Z M320 60 V700 M600 60 V700 M80 380 H880" stroke="#1e1712" stroke-width="22" fill="none"/>
      <rect x="1100" y="200" width="420" height="16" fill="#4a3624"/><rect x="1100" y="380" width="420" height="16" fill="#4a3624"/>
      <g>${[1130, 1210, 1300, 1390, 1460].map((x, i) => `<rect x="${x}" y="${150 - (i % 2) * 20}" width="40" height="${50 + (i % 2) * 20}" fill="${i % 2 ? '#c9b48f' : '#8c9a6b'}"/>`).join('')}${[1140, 1240, 1330, 1440].map((x, i) => `<rect x="${x}" y="${330 - (i % 2) * 14}" width="50" height="${50 + (i % 2) * 14}" fill="#d8ccb2"/>`).join('')}</g>
      <circle cx="1250" cy="40" r="60" fill="#ffd9a0" opacity="0.6" filter="url(#blur10)"/>
      <path d="M60 760 L1100 700 L1600 760 L1600 820 L60 840 Z" fill="#5a3820"/>
      ${woodTable(840, 111, ['#6f4526', '#3e2614'])}
      <path d="M100 720 Q100 520 300 520 Q500 520 500 720" stroke="#4a2c16" stroke-width="22" fill="none"/>
      <path d="M1000 760 Q1000 560 1200 560 Q1400 560 1400 760" stroke="#4a2c16" stroke-width="22" fill="none"/>
      <rect x="560" y="560" width="70" height="160" rx="30" fill="#d9e2d4" opacity="0.4"/>
      ${olive(595, 580, 220, -100, 113, '#5e7040')}${olive(595, 580, 200, -60, 114, '#5e7040')}
      <ellipse cx="760" cy="790" rx="120" ry="20" fill="#e9e1d1"/><path d="M700 720 Q700 790 760 790 Q820 790 820 720 Z" fill="#efe8da"/><path d="M820 735 Q860 740 845 770" stroke="#efe8da" stroke-width="10" fill="none"/>
      <rect x="900" y="770" width="220" height="30" rx="4" fill="#efe5d0" transform="rotate(-4 1010 785)"/>
      ${leafShadows(117, [0, 700, 1100, 500], 0.32)}`,
      { light: [0.2, 0.25], warmth: '#ffcf8a', vignette: 0.45 },
    ),

  // ...pendant lamps against a warm wall...
  'capture-v2/cafe-lamps': () =>
    frame(
      `<rect width="${W}" height="${H}" fill="#c8b493"/>
      <rect x="0" y="0" width="600" height="${H}" fill="#e9dcc3" opacity="0.6"/>
      ${[
        [620, 420],
        [920, 560],
      ]
        .map(
          ([x, y]) =>
            `<path d="M${x} 0 V${y! - 80}" stroke="#2b221a" stroke-width="4"/><path d="M${x! - 110} ${y} Q${x! - 110} ${y! - 120} ${x} ${y! - 120} Q${x! + 110} ${y! - 120} ${x! + 110} ${y} Z" fill="#f4ead6"/><ellipse cx="${x}" cy="${y}" rx="110" ry="16" fill="#fff4dc"/><circle cx="${x}" cy="${y! + 40}" r="160" fill="#ffd9a0" opacity="0.35" filter="url(#softer)"/>`,
        )
        .join('')}
      <rect x="160" y="620" width="200" height="260" fill="#4a3b2b"/><rect x="176" y="636" width="168" height="228" fill="#8d7c63"/>
      <rect y="1000" width="${W}" height="200" fill="#6a4a2e"/>
      <rect x="1100" y="760" width="180" height="240" rx="20" fill="#d9cdb6"/>
      ${olive(1190, 770, 360, -110, 121, '#56683a')}${olive(1190, 770, 330, -70, 122, '#56683a')}${olive(1190, 770, 280, -140, 123, '#56683a')}`,
      { light: [0.45, 0.4], warmth: '#ffcf8a', vignette: 0.4 },
    ),

  // ...and a table by the window with bentwood chairs.
  'capture-v2/cafe-window': () =>
    frame(
      `<rect width="${W}" height="${H}" fill="#3a3024"/>
      <rect x="100" y="80" width="1400" height="640" fill="#e6e0c8"/>
      <g fill="#7f925a" opacity="0.8">${Array.from({ length: 22 }, (_, i) => `<circle cx="${140 + ((i * 67) % 1340)}" cy="${140 + ((i * 131) % 520)}" r="${50 + (i % 3) * 25}"/>`).join('')}</g>
      <path d="M100 80 H1500 V720 H100 Z M450 80 V720 M800 80 V720 M1150 80 V720 M100 400 H1500" stroke="#1e1712" stroke-width="20" fill="none"/>
      ${woodTable(760, 131, ['#7a4c29', '#3e2614'])}
      <ellipse cx="800" cy="820" rx="460" ry="60" fill="#5d3a1e"/>
      ${[
        [300, 660],
        [1300, 660],
      ]
        .map(
          ([x, y]) =>
            `<path d="M${x! - 120} ${y! + 300} V${y} Q${x! - 120} ${y! - 140} ${x} ${y! - 140} Q${x! + 120} ${y! - 140} ${x! + 120} ${y} V${y! + 300}" stroke="#4a2c16" stroke-width="20" fill="none"/>`,
        )
        .join('')}
      <rect x="760" y="640" width="60" height="140" rx="26" fill="#dfe8da" opacity="0.4"/>${olive(790, 650, 200, -95, 133, '#5e7040')}`,
      { light: [0.5, 0.2], warmth: '#ffd08a', vignette: 0.45 },
    ),

  // 09 / mobile library extras: a whitewashed alley stepping down to the sea.
  'capture-v2/village-alley': () =>
    frame(
      `<defs><linearGradient id="skyJ" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb3d1"/><stop offset="1" stop-color="#d7e2e6"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#skyJ)"/>
      <path d="M560 520 Q800 440 1100 500 L1100 560 L560 560 Z" fill="#5e7480"/>
      <rect x="560" y="540" width="540" height="120" fill="#4f7a96"/>
      <path d="M0 0 L620 0 L620 1200 L0 1200 Z" fill="#d9c6a4"/><path d="M1040 0 L1600 0 L1600 1200 L1040 1200 Z" fill="#cdb894"/>
      <path d="M620 0 L700 660 L620 1200 Z" fill="#b9a27c"/><path d="M1040 0 L960 660 L1040 1200 Z" fill="#b19a74"/>
      <path d="M620 1200 L700 660 L960 660 L1040 1200 Z" fill="#c4ae8a"/>
      ${Array.from({ length: 10 }, (_, i) => `<path d="M${700 - i * 9} ${700 + i * 50} H${960 + i * 9}" stroke="#a48d68" stroke-width="5"/>`).join('')}
      <g fill="#58743d">${Array.from({ length: 40 }, (_, i) => `<circle cx="${(i * 37) % 600}" cy="${80 + ((i * 89) % 700)}" r="${30 + (i % 4) * 10}"/>`).join('')}</g>
      <g fill="#c8644a">${[
        [520, 1060],
        [1120, 1080],
        [180, 980],
      ]
        .map(
          ([x, y]) =>
            `<path d="M${x! - 50} ${y} L${x! + 50} ${y} L${x! + 36} ${y! + 90} L${x! - 36} ${y! + 90} Z"/>`,
        )
        .join('')}</g>
      <rect x="1180" y="300" width="120" height="200" fill="#3d5160"/>`,
      { light: [0.6, 0.1], warmth: '#fff0d0', vignette: 0.25 },
    ),
};

async function main() {
  for (const [name, draw] of Object.entries(scenes)) {
    const out = name.startsWith('capture/')
      ? path.join(root, 'apps/web/public', `${name}.jpg`)
      : path.join(root, 'fixtures', `${name}.jpg`);
    mkdirSync(path.dirname(out), { recursive: true });
    const jpeg = await sharp(Buffer.from(draw())).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    writeFileSync(out, jpeg);
    console.log(`${path.relative(root, out)}  ${Math.round(jpeg.byteLength / 1024)} KB`);
  }
}

await main();
