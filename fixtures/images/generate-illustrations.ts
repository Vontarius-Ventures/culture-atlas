/**
 * Generates the original sample illustrations used by "Try an example" and the
 * sample discovery feed. Every image is drawn here from code (SVG rendered to
 * JPEG with sharp), so the project owns them outright: no third-party photos,
 * no mockup screenshots, no likenesses of real people and no real logos.
 *
 *   pnpm exec tsx fixtures/images/generate-illustrations.ts
 *
 * Output: apps/web/public/samples/*.jpg and apps/web/public/samples/feed/*.jpg
 * (see fixtures/images/LICENSES.md). Re-running is deterministic.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
// sharp is a dependency of packages/domain; resolve it from there (pnpm does not hoist).
const require = createRequire(path.join(root, 'packages/domain/package.json'));
type Sharp = (input: Buffer) => {
  jpeg(options: { quality: number; mozjpeg: boolean }): { toBuffer(): Promise<Buffer> };
};
const sharp = require('sharp') as Sharp;

const W = 1000;
const H = 1250;

/** Deterministic PRNG so repeated runs produce identical files. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function frame(
  body: string,
  opts: { light?: [number, number]; warmth?: string; vignette?: number } = {},
) {
  const [lx, ly] = opts.light ?? [0.3, 0.2];
  const vignette = opts.vignette ?? 0.55;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="n"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.45  0 0 0 0 0.4  0 0 0 0.09 0"/>
    </filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter>
    <filter id="softer" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
    <filter id="blur6" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
    <radialGradient id="vig" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="${vignette}"/>
    </radialGradient>
    <radialGradient id="light" cx="${lx}" cy="${ly}" r="0.8">
      <stop offset="0" stop-color="${opts.warmth ?? '#ffd9a0'}" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#ffd9a0" stop-opacity="0"/>
    </radialGradient>
  </defs>
  ${body}
  <rect width="${W}" height="${H}" fill="url(#light)"/>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
  <rect width="${W}" height="${H}" filter="url(#grain)"/>
</svg>`;
}

const scenes: Record<string, () => string> = {
  // Example: outfit. A cream racing-style jacket with stripes on a wooden chair.
  outfit: () =>
    frame(
      `<defs>
        <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5a4a3b"/><stop offset="1" stop-color="#2a221c"/></linearGradient>
        <linearGradient id="jacket" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efe4cc"/><stop offset="0.6" stop-color="#d9c8a6"/><stop offset="1" stop-color="#a8916b"/></linearGradient>
        <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b4528"/><stop offset="1" stop-color="#3b2516"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#wall)"/>
      <rect x="80" y="120" width="380" height="250" fill="#6e5e4b" opacity="0.5"/>
      <rect x="100" y="140" width="340" height="210" fill="#3b332b" opacity="0.6"/>
      <rect x="0" y="1010" width="${W}" height="240" fill="url(#wood)"/>
      <rect x="120" y="980" width="760" height="40" rx="6" fill="#4a2f1c"/>
      <rect x="160" y="1010" width="34" height="240" fill="#3a2414"/>
      <rect x="806" y="1010" width="34" height="240" fill="#3a2414"/>
      <rect x="250" y="250" width="40" height="760" rx="8" fill="#4a2f1c"/>
      <rect x="710" y="250" width="40" height="760" rx="8" fill="#4a2f1c"/>
      <rect x="250" y="250" width="500" height="44" rx="10" fill="#5a3a22"/>
      <path d="M330 300 Q500 250 670 300 L760 360 Q800 520 790 720 L760 980 L620 990 L610 640 L560 990 L440 990 L390 640 L380 990 L240 980 L210 720 Q200 520 240 360 Z" fill="url(#jacket)"/>
      <path d="M440 290 Q500 330 560 290 L555 340 Q500 370 445 340 Z" fill="#cdbb98"/>
      <path d="M498 340 L502 990" stroke="#8d7a5c" stroke-width="5"/>
      <path d="M420 300 L400 980" stroke="#a6342b" stroke-width="44"/>
      <path d="M470 305 L455 985" stroke="#22324f" stroke-width="22"/>
      <path d="M580 300 L600 980" stroke="#a6342b" stroke-width="44"/>
      <path d="M530 305 L545 985" stroke="#22324f" stroke-width="22"/>
      <path d="M240 360 Q200 520 210 720 L250 940 L300 930 L285 700 Q290 520 320 400 Z" fill="#d8c7a3"/>
      <path d="M760 360 Q800 520 790 720 L750 940 L700 930 L715 700 Q710 520 680 400 Z" fill="#c9b690"/>
      <rect x="250" y="900" width="60" height="50" rx="10" fill="#b9a47e"/>
      <rect x="690" y="900" width="60" height="50" rx="10" fill="#a8916b"/>
      <circle cx="650" cy="520" r="34" fill="#efe4cc" stroke="#22324f" stroke-width="8"/>
      <circle cx="650" cy="520" r="14" fill="#a6342b"/>
      <path d="M0 1250 L0 900 Q150 860 210 980 L240 1250 Z" fill="#2b211a" opacity="0.8"/>`,
      { light: [0.62, 0.25] },
    ),

  // Example: room. Window grid with afternoon light, low table, vase with branch.
  room: () =>
    frame(
      `<defs>
        <linearGradient id="wall2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#cdb79a"/><stop offset="1" stop-color="#9c8467"/></linearGradient>
        <linearGradient id="win" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6ecd6"/><stop offset="1" stop-color="#d9e2c4"/></linearGradient>
        <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a77c52"/><stop offset="1" stop-color="#6b4a2d"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#wall2)"/>
      <rect x="140" y="120" width="720" height="620" fill="url(#win)"/>
      <g fill="#7a8f5c" opacity="0.55" filter="url(#soft)"><circle cx="300" cy="380" r="120"/><circle cx="560" cy="300" r="150"/><circle cx="760" cy="460" r="130"/></g>
      <g stroke="#5b3f27" stroke-width="16">
        <rect x="140" y="120" width="720" height="620" fill="none"/>
        <line x1="380" y1="120" x2="380" y2="740"/><line x1="620" y1="120" x2="620" y2="740"/>
      </g>
      <g stroke="#6d4c30" stroke-width="5">
        <line x1="140" y1="275" x2="860" y2="275"/><line x1="140" y1="430" x2="860" y2="430"/><line x1="140" y1="585" x2="860" y2="585"/>
        <line x1="260" y1="120" x2="260" y2="740"/><line x1="500" y1="120" x2="500" y2="740"/><line x1="740" y1="120" x2="740" y2="740"/>
      </g>
      <rect x="0" y="820" width="${W}" height="430" fill="url(#floor)"/>
      <polygon points="200,820 560,820 820,1250 300,1250" fill="#f3d9a8" opacity="0.35"/>
      <rect x="220" y="900" width="560" height="44" rx="8" fill="#5c3b22"/>
      <rect x="250" y="944" width="30" height="120" fill="#4a2f1b"/><rect x="720" y="944" width="30" height="120" fill="#4a2f1b"/>
      <path d="M560 900 Q545 830 575 790 Q600 770 625 790 Q655 830 640 900 Z" fill="#b48a5c"/>
      <path d="M600 790 Q590 650 520 560 M600 760 Q640 640 700 600 M598 700 Q560 660 540 640" stroke="#4a3a28" stroke-width="5" fill="none"/>
      <g fill="#6f8a4c"><ellipse cx="520" cy="560" rx="18" ry="9"/><ellipse cx="700" cy="600" rx="18" ry="9"/><ellipse cx="540" cy="640" rx="14" ry="7"/><ellipse cx="660" cy="620" rx="14" ry="7"/></g>
      <rect x="320" y="868" width="160" height="16" rx="3" fill="#e8dcc4"/><rect x="330" y="852" width="140" height="16" rx="3" fill="#8a6a4a"/>
      <ellipse cx="440" cy="1120" rx="190" ry="44" fill="#c9a77d"/>`,
      { light: [0.4, 0.3], vignette: 0.45 },
    ),

  // Example: café table. Marble table, cup and saucer, pastry, cane chair back.
  cafe: () =>
    frame(
      `<defs>
        <linearGradient id="bg3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a2f26"/><stop offset="1" stop-color="#1f1914"/></linearGradient>
        <radialGradient id="marble" cx="0.5" cy="0.4" r="0.7"><stop offset="0" stop-color="#f1ece3"/><stop offset="1" stop-color="#c9c1b4"/></radialGradient>
        <radialGradient id="coffee" cx="0.45" cy="0.4" r="0.6"><stop offset="0" stop-color="#6a3c1e"/><stop offset="1" stop-color="#2b160a"/></radialGradient>
        <linearGradient id="pastry" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e7a85a"/><stop offset="1" stop-color="#9a5a22"/></linearGradient>
        <pattern id="cane" width="28" height="28" patternUnits="userSpaceOnUse"><rect width="28" height="28" fill="#b99666"/><circle cx="14" cy="14" r="7" fill="#3a2b1d"/></pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg3)"/>
      <g opacity="0.5" filter="url(#softer)"><rect x="60" y="80" width="260" height="380" fill="#8a6a44"/><rect x="620" y="60" width="300" height="300" fill="#a07a4a"/></g>
      <path d="M640 220 Q820 200 900 300 L930 700 L620 720 Z" fill="url(#cane)" stroke="#6b4a2a" stroke-width="22"/>
      <ellipse cx="480" cy="900" rx="560" ry="320" fill="url(#marble)"/>
      <path d="M100 820 Q300 760 420 900 T820 960" stroke="#b9b0a2" stroke-width="3" fill="none" opacity="0.7"/>
      <path d="M200 1050 Q380 980 520 1080" stroke="#b9b0a2" stroke-width="2" fill="none" opacity="0.6"/>
      <ellipse cx="420" cy="860" rx="200" ry="70" fill="#000" opacity="0.18" filter="url(#blur6)"/>
      <ellipse cx="410" cy="840" rx="200" ry="72" fill="#f7f4ee" stroke="#d8d1c4" stroke-width="4"/>
      <path d="M300 640 L320 820 Q410 870 500 820 L520 640 Z" fill="#f4efe6"/>
      <path d="M520 680 Q600 690 590 750 Q580 800 510 790" stroke="#efe9de" stroke-width="22" fill="none"/>
      <ellipse cx="410" cy="640" rx="110" ry="34" fill="#efe9de"/>
      <ellipse cx="410" cy="644" rx="96" ry="26" fill="url(#coffee)"/>
      <ellipse cx="392" cy="638" rx="40" ry="8" fill="#c79a6a" opacity="0.5"/>
      <ellipse cx="740" cy="960" rx="150" ry="40" fill="#000" opacity="0.18" filter="url(#blur6)"/>
      <path d="M600 940 Q620 860 700 850 Q780 840 860 880 Q900 920 870 960 Q760 990 640 975 Z" fill="url(#pastry)"/>
      <path d="M660 870 Q690 930 680 970 M730 852 Q750 920 745 980 M800 860 Q815 920 810 975" stroke="#7a4518" stroke-width="5" fill="none" opacity="0.7"/>`,
      { light: [0.35, 0.45], vignette: 0.6 },
    ),

  'feed/sunday-listening': () =>
    frame(
      `<defs>
        <linearGradient id="bg4" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4b3a2b"/><stop offset="1" stop-color="#2a1f17"/></linearGradient>
        <radialGradient id="vinyl" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#2a2a2a"/><stop offset="0.9" stop-color="#0e0e0e"/><stop offset="1" stop-color="#2b2b2b"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg4)"/>
      <g opacity="0.85">${Array.from({ length: 14 }, (_, i) => `<rect x="${60 + i * 22}" y="${300 - (i % 3) * 8}" width="18" height="460" fill="${['#7a5f45', '#a48a6a', '#5b4636', '#c2b29a', '#3f342b'][i % 5]}"/>`).join('')}</g>
      <rect x="120" y="320" width="300" height="300" fill="#d8ccb6"/><rect x="150" y="350" width="240" height="240" fill="#38302a"/>
      <ellipse cx="270" cy="450" rx="60" ry="80" fill="#5c5046"/>
      <path d="M560 160 L640 160 L690 300 L510 300 Z" fill="#d9c49a"/><rect x="590" y="300" width="20" height="230" fill="#8a6a4a"/>
      <ellipse cx="600" cy="300" rx="90" ry="14" fill="#f3e3bd" opacity="0.8"/>
      <rect x="80" y="760" width="840" height="420" rx="16" fill="#5a3b24"/>
      <rect x="80" y="760" width="840" height="30" rx="8" fill="#6d4a2e"/>
      <ellipse cx="460" cy="900" rx="330" ry="120" fill="url(#vinyl)"/>
      ${Array.from({ length: 6 }, (_, i) => `<ellipse cx="460" cy="900" rx="${300 - i * 34}" ry="${108 - i * 12}" fill="none" stroke="#3a3a3a" stroke-width="2"/>`).join('')}
      <ellipse cx="460" cy="900" rx="70" ry="26" fill="#c8682f"/><circle cx="460" cy="900" r="5" fill="#ddd"/>
      <path d="M820 820 L780 860 L640 930" stroke="#c9c9c9" stroke-width="10" fill="none" stroke-linecap="round"/>
      <circle cx="820" cy="820" r="24" fill="#8f8f8f"/>`,
      { light: [0.6, 0.2] },
    ),

  'feed/around-the-table': () =>
    frame(
      `<defs>
        <linearGradient id="table5" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9b6b43"/><stop offset="1" stop-color="#5d3d22"/></linearGradient>
        <radialGradient id="pasta" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#e9b25a"/><stop offset="1" stop-color="#c47a32"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#table5)"/>
      ${Array.from({ length: 8 }, (_, i) => `<line x1="0" y1="${i * 170 + 40}" x2="${W}" y2="${i * 170 + 10}" stroke="#4d321c" stroke-width="3" opacity="0.5"/>`).join('')}
      <ellipse cx="520" cy="820" rx="300" ry="250" fill="#f1ebe0"/><ellipse cx="520" cy="820" rx="230" ry="190" fill="url(#pasta)"/>
      ${(() => {
        const r = rng(5);
        return Array.from(
          { length: 22 },
          () =>
            `<circle cx="${400 + r() * 240}" cy="${700 + r() * 240}" r="${12 + r() * 10}" fill="${r() > 0.5 ? '#c4332a' : '#d9472f'}"/>`,
        ).join('');
      })()}
      ${(() => {
        const r = rng(9);
        return Array.from(
          { length: 8 },
          () =>
            `<ellipse cx="${420 + r() * 200}" cy="${720 + r() * 200}" rx="18" ry="9" fill="#3f7a35" transform="rotate(${r() * 180} 520 820)"/>`,
        ).join('');
      })()}
      <ellipse cx="200" cy="330" rx="170" ry="150" fill="#e9e2d4" stroke="#2f5a8a" stroke-width="12"/><ellipse cx="200" cy="330" rx="120" ry="104" fill="#b8402e"/>
      <ellipse cx="760" cy="320" rx="150" ry="120" fill="#e3d4b5"/>
      <path d="M660 300 Q760 220 860 300 Q840 380 760 390 Q680 380 660 300 Z" fill="#c99a5a"/>
      <circle cx="830" cy="560" r="80" fill="#4a1c1f" opacity="0.85"/><circle cx="830" cy="560" r="95" fill="none" stroke="#e8e2d6" stroke-width="6" opacity="0.7"/>
      <g transform="translate(120 980)"><ellipse cx="80" cy="60" rx="110" ry="80" fill="#f0e7d8"/><circle cx="60" cy="50" r="30" fill="#d7462f"/><circle cx="110" cy="70" r="26" fill="#e3a63b"/></g>`,
      { light: [0.5, 0.15], vignette: 0.5 },
    ),

  'feed/night-wanderings': () =>
    frame(
      `<defs>
        <linearGradient id="sky6" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1526"/><stop offset="1" stop-color="#2b2232"/></linearGradient>
        <linearGradient id="street" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a2a1f"/><stop offset="1" stop-color="#7a5230"/></linearGradient>
        <radialGradient id="lamp" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffe2a0"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#sky6)"/>
      <polygon points="0,0 380,380 380,900 0,1250" fill="#5a3b26"/>
      <polygon points="${W},0 620,380 620,900 ${W},1250" fill="#4a3020"/>
      <polygon points="380,900 620,900 ${W},1250 0,1250" fill="url(#street)"/>
      ${Array.from({ length: 5 }, (_, i) => `<rect x="${60 + i * 50}" y="${220 + i * 120}" width="${70 - i * 8}" height="${110 - i * 12}" fill="#f2b863" opacity="0.8"/>`).join('')}
      ${Array.from({ length: 5 }, (_, i) => `<rect x="${W - 130 - i * 50}" y="${220 + i * 120}" width="${70 - i * 8}" height="${110 - i * 12}" fill="#f2b863" opacity="0.7"/>`).join('')}
      ${[
        [250, 540, 140],
        [770, 520, 130],
        [430, 700, 70],
        [580, 690, 70],
      ]
        .map(
          ([x, y, r]) =>
            `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#lamp)"/><circle cx="${x}" cy="${y}" r="${r! / 9}" fill="#fff3d0"/>`,
        )
        .join('')}
      ${(() => {
        const r = rng(3);
        return Array.from({ length: 40 }, () => {
          const x = 120 + r() * 760;
          const y = 950 + r() * 280;
          return `<ellipse cx="${x}" cy="${y}" rx="${20 + r() * 30}" ry="${4 + r() * 4}" fill="#ffc777" opacity="${0.15 + r() * 0.3}"/>`;
        }).join('');
      })()}
      <g fill="#120d0a"><ellipse cx="470" cy="820" rx="16" ry="20"/><rect x="456" y="836" width="28" height="80" rx="10"/><ellipse cx="540" cy="830" rx="14" ry="18"/><rect x="528" y="846" width="24" height="70" rx="9"/></g>`,
      { light: [0.5, 0.6], warmth: '#ffb347', vignette: 0.6 },
    ),

  'feed/sculptural-forms': () =>
    frame(
      `<defs>
        <linearGradient id="bg7" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e2d9cb"/><stop offset="1" stop-color="#b9ad9b"/></linearGradient>
        <radialGradient id="boucle" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#fbf7ef"/><stop offset="1" stop-color="#cfc5b4"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg7)"/>
      <rect x="0" y="960" width="${W}" height="290" fill="#a99a84"/>
      <ellipse cx="500" cy="1080" rx="440" ry="90" fill="#c9bba4"/>
      <ellipse cx="500" cy="1040" rx="330" ry="40" fill="#000" opacity="0.15" filter="url(#blur6)"/>
      <path d="M260 1020 Q200 820 300 640 Q360 500 480 520 Q560 540 540 640 Q520 720 600 740 Q760 760 760 880 Q760 1020 640 1030 Q560 1035 500 1000 Q420 1040 260 1020 Z" fill="url(#boucle)"/>
      <path d="M330 900 Q420 860 560 880" stroke="#d9cfbe" stroke-width="10" fill="none"/>
      <path d="M760 520 L880 520 L870 940 L770 940 Z" fill="#7d6047"/>
      <path d="M815 520 Q800 450 820 420 Q840 400 860 420 Q875 450 860 520 Z" fill="#3b2f27"/>
      <path d="M840 420 Q820 300 760 230 M840 400 Q880 300 940 270 M838 360 Q800 340 790 300" stroke="#3f3326" stroke-width="5" fill="none"/>
      <g fill="#556b3f"><ellipse cx="760" cy="230" rx="16" ry="8"/><ellipse cx="940" cy="270" rx="16" ry="8"/><ellipse cx="790" cy="300" rx="12" ry="6"/></g>
      <rect x="80" y="700" width="140" height="22" fill="#4b3d33"/><rect x="90" y="676" width="120" height="24" fill="#e6dccb"/>`,
      { light: [0.25, 0.2], vignette: 0.35 },
    ),

  'feed/linen-days': () =>
    frame(
      `<defs>
        <linearGradient id="bg8" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ede5d6"/><stop offset="1" stop-color="#cbbfab"/></linearGradient>
        <linearGradient id="linen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f6f0e4"/><stop offset="0.5" stop-color="#e8decb"/><stop offset="1" stop-color="#d4c6ae"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg8)"/>
      <g fill="#8a7a62" opacity="0.28" filter="url(#soft)">${(() => {
        const r = rng(11);
        return Array.from(
          { length: 16 },
          () =>
            `<ellipse cx="${r() * W}" cy="${r() * 600}" rx="${40 + r() * 50}" ry="${14 + r() * 10}" transform="rotate(${r() * 90 - 45} ${500} ${300})"/>`,
        ).join('');
      })()}</g>
      <path d="M500 120 Q520 120 520 140 Q520 160 500 170" stroke="#6b5a45" stroke-width="7" fill="none"/>
      <path d="M500 180 L330 250 L670 250 Z" fill="none" stroke="#7a6248" stroke-width="10"/>
      <path d="M330 250 L670 250 L790 340 L860 640 L760 660 L720 470 L720 1100 L280 1100 L280 470 L240 660 L140 640 L210 340 Z" fill="url(#linen)"/>
      <path d="M440 250 L500 380 L560 250" fill="#ddd2bd" stroke="#cbbda4" stroke-width="4"/>
      <path d="M500 380 L500 1100" stroke="#cdbfa6" stroke-width="4"/>
      ${Array.from({ length: 7 }, (_, i) => `<circle cx="512" cy="${430 + i * 95}" r="7" fill="#efe8da" stroke="#bcae95" stroke-width="2"/>`).join('')}
      <path d="M330 520 Q400 560 380 700 M640 560 Q600 640 650 760 M360 880 Q420 930 400 1040" stroke="#d2c4ab" stroke-width="5" fill="none"/>
      <rect x="320" y="420" width="90" height="80" fill="#e2d7c3" stroke="#cdbfa6" stroke-width="3"/>`,
      { light: [0.7, 0.2], vignette: 0.3 },
    ),

  'feed/tea-rituals': () =>
    frame(
      `<defs>
        <linearGradient id="bg9" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a4634"/><stop offset="1" stop-color="#3a2c20"/></linearGradient>
        <linearGradient id="table9" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6e4a2c"/><stop offset="1" stop-color="#4a3019"/></linearGradient>
        <radialGradient id="iron" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#4a4744"/><stop offset="1" stop-color="#151413"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg9)"/>
      <g opacity="0.6" filter="url(#softer)"><rect x="600" y="0" width="400" height="600" fill="#9cad84"/></g>
      <rect x="0" y="760" width="${W}" height="490" fill="url(#table9)"/>
      <path d="M200 700 Q190 600 230 560 L270 560 Q310 600 300 700 Z" fill="#b8a07a"/>
      <path d="M250 560 Q240 420 180 320 M250 520 Q290 400 360 330 M248 480 Q220 430 200 410" stroke="#4a3626" stroke-width="5" fill="none"/>
      <g fill="#f1d7d9">${[
        [180, 320],
        [360, 330],
        [200, 410],
        [300, 370],
        [220, 360],
        [340, 300],
      ]
        .map(
          ([x, y]) =>
            `<circle cx="${x}" cy="${y}" r="16"/><circle cx="${x! + 12}" cy="${y! - 10}" r="12" fill="#e8b9bf"/>`,
        )
        .join('')}</g>
      <ellipse cx="620" cy="900" rx="230" ry="50" fill="#000" opacity="0.25" filter="url(#blur6)"/>
      <path d="M440 700 Q430 900 620 920 Q810 900 800 700 Q780 620 620 610 Q460 620 440 700 Z" fill="url(#iron)"/>
      ${Array.from({ length: 6 }, (_, r) => Array.from({ length: 9 }, (_, c) => `<circle cx="${470 + c * 38}" cy="${680 + r * 36}" r="5" fill="#2a2826"/>`).join('')).join('')}
      <path d="M800 720 Q880 700 900 640" stroke="#1b1a19" stroke-width="22" fill="none" stroke-linecap="round"/>
      <path d="M500 620 Q620 470 740 620" stroke="#1b1a19" stroke-width="16" fill="none"/>
      <ellipse cx="620" cy="612" rx="70" ry="18" fill="#2b2927"/><circle cx="620" cy="590" r="14" fill="#2b2927"/>
      <path d="M140 960 L170 1060 Q230 1080 290 1060 L320 960 Z" fill="#c8b88f"/><ellipse cx="230" cy="960" rx="90" ry="24" fill="#d8caa3"/><ellipse cx="230" cy="964" rx="76" ry="16" fill="#9caf5c"/>`,
      { light: [0.75, 0.15], vignette: 0.55 },
    ),

  'feed/late-night-cinema': () =>
    frame(
      `<defs>
        <linearGradient id="bg10" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#140f12"/><stop offset="1" stop-color="#2a1b18"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg10)"/>
      <polygon points="80,260 920,200 940,380 60,420" fill="#3a1e14"/>
      <polygon points="80,260 920,200 940,380 60,420" fill="none" stroke="#e8b04a" stroke-width="6"/>
      ${Array.from({ length: 22 }, (_, i) => `<circle cx="${90 + i * 39}" cy="${262 - i * 2.8}" r="7" fill="#ffd27a"/><circle cx="${70 + i * 40}" cy="${420 - i * 1.9}" r="7" fill="#ffd27a"/>`).join('')}
      <g fill="#f1c36a">${'CINEMA'
        .split('')
        .map(
          (_, i) =>
            `<rect x="${230 + i * 95}" y="${280 - i * 4}" width="62" height="78" rx="6" opacity="0.9"/>`,
        )
        .join('')}</g>
      <rect x="120" y="460" width="200" height="320" fill="#2c3e5a"/><rect x="680" y="460" width="200" height="320" fill="#6a2a24"/>
      <rect x="135" y="475" width="170" height="290" fill="#3d5478" opacity="0.6"/><rect x="695" y="475" width="170" height="290" fill="#8a3a2e" opacity="0.6"/>
      <rect x="360" y="440" width="280" height="500" fill="#5a3826" opacity="0.8"/>
      <rect x="0" y="940" width="${W}" height="310" fill="#2b1f19"/>
      <g fill="#0d0a09"><ellipse cx="420" cy="830" rx="70" ry="80"/><path d="M330 1250 Q330 920 420 900 Q510 920 520 1250 Z"/><ellipse cx="610" cy="840" rx="62" ry="74"/><path d="M530 1250 Q530 930 610 910 Q700 930 700 1250 Z"/></g>`,
      { light: [0.5, 0.25], warmth: '#ffb347', vignette: 0.6 },
    ),

  'feed/something-to-share': () =>
    frame(
      `<defs>
        <linearGradient id="table11" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5d38"/><stop offset="1" stop-color="#4f331d"/></linearGradient>
        <radialGradient id="bowl11" cx="0.5" cy="0.45" r="0.55"><stop offset="0" stop-color="#d8cdb9"/><stop offset="1" stop-color="#8c8170"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#table11)"/>
      <ellipse cx="500" cy="680" rx="400" ry="360" fill="url(#bowl11)"/>
      <ellipse cx="500" cy="660" rx="340" ry="300" fill="#4f6b2f"/>
      ${(() => {
        const r = rng(21);
        const cols = ['#6f9a3c', '#9fc25a', '#3e5b25', '#c94b5a', '#f0e6d8', '#e4a23c', '#8fbf6a'];
        return Array.from({ length: 90 }, () => {
          const a = r() * Math.PI * 2;
          const d = Math.sqrt(r()) * 280;
          const x = 500 + Math.cos(a) * d;
          const y = 660 + Math.sin(a) * d * 0.9;
          const c = cols[Math.floor(r() * cols.length)];
          return `<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(16 + r() * 22).toFixed(0)}" ry="${(8 + r() * 12).toFixed(0)}" fill="${c}" transform="rotate(${(r() * 180).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"/>`;
        }).join('');
      })()}
      ${[
        [420, 560],
        [600, 620],
        [520, 760],
        [380, 700],
      ]
        .map(
          ([x, y]) =>
            `<circle cx="${x}" cy="${y}" r="34" fill="#f2e4e6" stroke="#c43a55" stroke-width="8"/>`,
        )
        .join('')}
      <ellipse cx="160" cy="1080" rx="110" ry="90" fill="#e8e2d8" opacity="0.9"/><ellipse cx="160" cy="1080" rx="80" ry="64" fill="#c3462c"/>
      <rect x="760" y="1000" width="140" height="190" rx="20" fill="#dfe8ea" opacity="0.45"/>`,
      { light: [0.3, 0.2], vignette: 0.5 },
    ),

  'feed/sesame-noodles': () =>
    frame(
      `<defs>
        <linearGradient id="bg12" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a5234"/><stop offset="1" stop-color="#3e281a"/></linearGradient>
        <radialGradient id="bowl12" cx="0.5" cy="0.3" r="0.8"><stop offset="0" stop-color="#f4efe6"/><stop offset="1" stop-color="#bdb4a5"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg12)"/>
      <ellipse cx="500" cy="760" rx="390" ry="300" fill="url(#bowl12)"/>
      <ellipse cx="500" cy="720" rx="320" ry="220" fill="#b8742e"/>
      ${(() => {
        const r = rng(31);
        return Array.from({ length: 70 }, () => {
          const x = 220 + r() * 560;
          const y = 560 + r() * 320;
          return `<path d="M${x.toFixed(0)} ${y.toFixed(0)} q ${(30 + r() * 40).toFixed(0)} ${(-30 + r() * 60).toFixed(0)} ${(60 + r() * 60).toFixed(0)} ${(-10 + r() * 20).toFixed(0)}" stroke="${r() > 0.5 ? '#e0a052' : '#c98a3c'}" stroke-width="9" fill="none" stroke-linecap="round"/>`;
        }).join('');
      })()}
      ${(() => {
        const r = rng(37);
        return (
          Array.from(
            { length: 30 },
            () =>
              `<circle cx="${(320 + r() * 360).toFixed(0)}" cy="${(600 + r() * 220).toFixed(0)}" r="9" fill="#5f9a3a"/>`,
          ).join('') +
          Array.from(
            { length: 50 },
            () =>
              `<ellipse cx="${(300 + r() * 400).toFixed(0)}" cy="${(580 + r() * 260).toFixed(0)}" rx="4" ry="2.5" fill="#f6ecd2"/>`,
          ).join('')
        );
      })()}
      <path d="M760 200 L960 520" stroke="#3a2617" stroke-width="16" stroke-linecap="round"/><path d="M800 180 L990 480" stroke="#4a311e" stroke-width="16" stroke-linecap="round"/>`,
      { light: [0.35, 0.2], vignette: 0.45 },
    ),

  'feed/cucumber-salad': () =>
    frame(
      `<defs>
        <linearGradient id="bg13" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a5f3c"/><stop offset="1" stop-color="#4a301c"/></linearGradient>
        <radialGradient id="bowl13" cx="0.5" cy="0.3" r="0.8"><stop offset="0" stop-color="#e9e2d6"/><stop offset="1" stop-color="#a39887"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg13)"/>
      <ellipse cx="500" cy="740" rx="400" ry="320" fill="url(#bowl13)"/>
      <ellipse cx="500" cy="700" rx="320" ry="230" fill="#4f7a2e"/>
      ${(() => {
        const r = rng(41);
        return Array.from({ length: 34 }, () => {
          const x = 250 + r() * 500;
          const y = 540 + r() * 320;
          return `<g transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) rotate(${(r() * 60 - 30).toFixed(0)})"><ellipse rx="44" ry="30" fill="#3f6a25"/><ellipse rx="36" ry="23" fill="#cfe3a2"/><ellipse rx="18" ry="11" fill="#e8f0c8"/>${[0, 60, 120, 180, 240, 300].map((d) => `<circle cx="${(Math.cos((d * Math.PI) / 180) * 12).toFixed(1)}" cy="${(Math.sin((d * Math.PI) / 180) * 7).toFixed(1)}" r="2.5" fill="#a8c47a"/>`).join('')}</g>`;
        }).join('');
      })()}
      ${(() => {
        const r = rng(43);
        return Array.from(
          { length: 26 },
          () =>
            `<rect x="${(300 + r() * 400).toFixed(0)}" y="${(560 + r() * 260).toFixed(0)}" width="10" height="6" fill="#c9302c"/>`,
        ).join('');
      })()}`,
      { light: [0.6, 0.2], vignette: 0.45 },
    ),

  'feed/rainy-alley': () =>
    frame(
      `<defs>
        <linearGradient id="bg14" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1410"/><stop offset="1" stop-color="#3a2416"/></linearGradient>
        <radialGradient id="lantern" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ff7a4a"/><stop offset="1" stop-color="#c2221a" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg14)"/>
      <polygon points="0,0 420,300 420,980 0,1250" fill="#4a2c1c"/>
      <polygon points="${W},0 580,300 580,980 ${W},1250" fill="#3b2216"/>
      <polygon points="420,980 580,980 ${W},1250 0,1250" fill="#2a1a12"/>
      ${[
        [300, 360],
        [700, 340],
        [360, 560],
        [640, 540],
        [450, 700],
        [560, 690],
      ]
        .map(
          ([x, y], i) =>
            `<circle cx="${x}" cy="${y}" r="${110 - i * 12}" fill="url(#lantern)"/><ellipse cx="${x}" cy="${y}" rx="${30 - i * 3}" ry="${38 - i * 4}" fill="#e2412c"/><rect x="${x! - 4}" y="${y! - 60 + i * 4}" width="8" height="${24 - i * 2}" fill="#1c1410"/>`,
        )
        .join('')}
      ${Array.from({ length: 6 }, (_, i) => `<rect x="${80 + i * 40}" y="${300 + i * 100}" width="${44 - i * 5}" height="${150 - i * 16}" fill="#c2332a" opacity="0.6"/>`).join('')}
      ${(() => {
        const r = rng(51);
        return Array.from({ length: 34 }, () => {
          const x = 200 + r() * 600;
          const y = 1000 + r() * 230;
          return `<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(10 + r() * 30).toFixed(0)}" ry="3" fill="#ff8a5a" opacity="${(0.2 + r() * 0.3).toFixed(2)}"/>`;
        }).join('');
      })()}
      <g fill="#0b0807"><ellipse cx="500" cy="840" rx="16" ry="20"/><rect x="486" y="856" width="28" height="90" rx="10"/></g>`,
      { light: [0.5, 0.4], warmth: '#ff7a4a', vignette: 0.65 },
    ),

  'feed/softer-silhouette': () =>
    frame(
      `<defs>
        <linearGradient id="bg15" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9e0cf"/><stop offset="1" stop-color="#b8a98f"/></linearGradient>
        <linearGradient id="blazer" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6dcc8"/><stop offset="1" stop-color="#b9aa8e"/></linearGradient>
        <pattern id="cane15" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="24" height="24" fill="#b48d5c"/><circle cx="12" cy="12" r="6" fill="#6b4c2c"/></pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg15)"/>
      <g opacity="0.5" filter="url(#softer)"><circle cx="820" cy="200" r="160" fill="#7f9a5c"/></g>
      <rect x="560" y="300" width="340" height="760" rx="20" fill="url(#cane15)" stroke="#7a5532" stroke-width="22"/>
      <path d="M380 260 Q500 220 620 260 L700 320 Q740 600 720 1000 L560 1010 L540 700 L500 1010 L300 1010 L280 700 L260 1000 L120 990 Q120 600 300 320 Z" fill="url(#blazer)"/>
      <path d="M440 250 L500 520 L560 250" fill="#d8ccb4" stroke="#bfae90" stroke-width="5"/>
      <path d="M470 500 L500 1010" stroke="#bfae90" stroke-width="4"/>
      <circle cx="520" cy="680" r="9" fill="#9c8a6a"/><circle cx="520" cy="780" r="9" fill="#9c8a6a"/>
      <rect x="590" y="580" width="90" height="10" fill="#bfae90"/>`,
      { light: [0.3, 0.2], vignette: 0.3 },
    ),

  'feed/blossom-branch': () =>
    frame(
      `<defs>
        <linearGradient id="bg16" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b48f86"/><stop offset="1" stop-color="#5b4a45"/></linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg16)"/>
      <g opacity="0.55" filter="url(#softer)">${(() => {
        const r = rng(61);
        return Array.from(
          { length: 12 },
          () =>
            `<circle cx="${(r() * W).toFixed(0)}" cy="${(r() * H).toFixed(0)}" r="${(60 + r() * 80).toFixed(0)}" fill="${r() > 0.5 ? '#e8b7bd' : '#f3d6d2'}"/>`,
        ).join('');
      })()}</g>
      <path d="M0 900 Q300 760 520 640 Q700 540 1000 300" stroke="#3a2a24" stroke-width="22" fill="none"/>
      <path d="M380 710 Q420 560 380 420 M640 570 Q720 640 820 640 M760 450 Q760 360 700 280" stroke="#3a2a24" stroke-width="10" fill="none"/>
      ${(() => {
        const r = rng(67);
        const pts: Array<[number, number]> = [
          [380, 420],
          [400, 520],
          [820, 640],
          [700, 280],
          [740, 380],
          [560, 620],
          [220, 820],
          [880, 380],
          [300, 760],
          [460, 660],
          [660, 520],
          [760, 600],
        ];
        return pts
          .map(
            ([x, y]) =>
              [0, 72, 144, 216, 288]
                .map(
                  (d) =>
                    `<ellipse cx="${(x + Math.cos((d * Math.PI) / 180) * 18).toFixed(0)}" cy="${(y + Math.sin((d * Math.PI) / 180) * 18).toFixed(0)}" rx="16" ry="11" fill="${r() > 0.4 ? '#f8dfe2' : '#efc2c8'}" transform="rotate(${d} ${x} ${y})"/>`,
                )
                .join('') + `<circle cx="${x}" cy="${y}" r="6" fill="#c9586a"/>`,
          )
          .join('');
      })()}`,
      { light: [0.6, 0.3], vignette: 0.45 },
    ),
};

async function main() {
  const outDir = path.join(root, 'apps/web/public/samples');
  mkdirSync(path.join(outDir, 'feed'), { recursive: true });
  for (const [name, draw] of Object.entries(scenes)) {
    const svg = draw();
    const file = path.join(outDir, `${name}.jpg`);
    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    writeFileSync(file, jpeg);
    console.log(`${path.relative(root, file)}  ${Math.round(jpeg.byteLength / 1024)} KB`);
  }
}

await main();
