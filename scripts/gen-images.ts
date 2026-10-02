/**
 * Renders the web-app icons and the social preview image into public/ with a local headless
 * Chrome or Edge (set CHROME_PATH to point at one explicitly).
 *
 *   node scripts/gen-images.ts
 *
 * The PNGs are committed, so building and deploying never needs a browser; rerun this only when
 * the artwork changes. The artwork is drawn from the same procedural card faces the game uses.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCards } from '../src/engine/cards.ts';
import { cardFaceUrl } from '../src/assets/cards.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public');

function findBrowser(): string {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found. Set CHROME_PATH to a Chromium-based browser.');
  return found;
}

const SPADE = 'M50 18c4 8 26 22 26 38 0 10-7 16-15 16-5 0-8-2-10-5 1 6 3 10 8 13H41c5-3 7-7 8-13-2 3-5 5-10 5-8 0-15-6-15-16 0-16 22-30 26-38Z';
const DISPLAY = "'Playfair Display', 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";

/** The game's display face, embedded so the images match the page on any machine. */
function fontFaces(): string {
  const face = (style: 'normal' | 'italic') => {
    const file = resolve(root, `node_modules/@fontsource/playfair-display/files/playfair-display-latin-600-${style}.woff2`);
    const data = readFileSync(file).toString('base64');
    return `@font-face{font-family:'Playfair Display';font-style:${style};font-weight:600;src:url(data:font/woff2;base64,${data}) format('woff2')}`;
  };
  return face('normal') + face('italic');
}
const UI = "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Roboto, Arial, sans-serif";

/** The spade mark. `bleed` fills the whole square (maskable / Apple icons); otherwise a disc on transparency. */
function iconSvg(bleed: boolean): string {
  const bg = bleed
    ? '<rect width="100" height="100" fill="url(#g)"/>'
    : '<circle cx="50" cy="50" r="48" fill="url(#g)"/><circle cx="50" cy="50" r="45.5" fill="none" stroke="#d4b06a" stroke-opacity=".45" stroke-width="1.2"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">
  <defs><radialGradient id="g" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="#8a2a3b"/><stop offset="1" stop-color="#4a1019"/></radialGradient>
  <linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0d592"/><stop offset="1" stop-color="#b98d42"/></linearGradient></defs>
  ${bg}<path d="${SPADE}" fill="url(#s)"/></svg>`;
}

function page(width: number, height: number, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces()}
  html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}
  </style></head><body>${body}</body></html>`;
}

function socialPage(): string {
  const cards = parseCards('Ts Js Qs Ks As')
    .map((c, i) => `<img src="${cardFaceUrl(c, { fourColor: false })}" style="--i:${i - 2}">`)
    .join('');
  return page(
    1200,
    630,
    `
  <style>
    .wrap{position:relative;width:1200px;height:630px;overflow:hidden;font-family:${UI};color:#efe9dc;
      background:radial-gradient(ellipse 75% 70% at 72% 55%, #1f5a45 0%, #123529 45%, #0c110f 100%)}
    .rail{position:absolute;right:-180px;top:40px;width:900px;height:560px;border-radius:280px;
      box-shadow:inset 0 0 0 14px #3a1d14, inset 0 0 0 16px #d4b06a55, inset 0 0 90px #0008}
    .fan{position:absolute;left:790px;top:170px}
    .fan img{position:absolute;width:190px;left:-95px;top:0;transform-origin:50% 140%;
      transform:rotate(calc(var(--i) * 11deg)) translateY(calc(abs(var(--i)) * 8px));
      filter:drop-shadow(0 10px 18px #0009);border-radius:12px}
    .text{position:absolute;left:84px;top:150px;width:560px}
    .mark{width:74px;height:74px;margin-bottom:22px}
    h1{margin:0;font:italic 600 108px/1 ${DISPLAY};color:#d8b46d;letter-spacing:.01em}
    h2{margin:10px 0 0;font:600 38px/1.2 ${DISPLAY};color:#efe9dc}
    p{margin:26px 0 0;font:400 25px/1.45 ${UI};color:#c9c2b3}
    .pill{display:inline-block;margin-top:30px;padding:9px 18px;border-radius:999px;border:1.5px solid #d8b46d88;color:#e9c877;font:600 20px/1 ${UI};letter-spacing:.04em}
  </style>
  <div class="wrap"><div class="rail"></div>
    <div class="text">
      <div class="mark">${iconSvg(false)}</div>
      <h1>Velvet</h1>
      <h2>No-Limit Texas Hold'em</h2>
      <p>Outplay AI opponents who read the table, model your habits and never cheat.</p>
      <span class="pill">FREE · IN YOUR BROWSER · PLAY MONEY</span>
    </div>
    <div class="fan">${cards}</div>
  </div>`,
  );
}

const jobs: { file: string; width: number; height: number; html: string }[] = [
  { file: 'icon-192.png', width: 192, height: 192, html: page(192, 192, iconSvg(false)) },
  { file: 'icon-512.png', width: 512, height: 512, html: page(512, 512, iconSvg(false)) },
  { file: 'icon-maskable-512.png', width: 512, height: 512, html: page(512, 512, iconSvg(true)) },
  { file: 'apple-touch-icon.png', width: 180, height: 180, html: page(180, 180, iconSvg(true)) },
  { file: 'og-image.png', width: 1200, height: 630, html: socialPage() },
];

const browser = findBrowser();
const temp = mkdtempSync(join(tmpdir(), 'velvet-img-'));
mkdirSync(out, { recursive: true });
try {
  for (const job of jobs) {
    const src = join(temp, job.file.replace('.png', '.html'));
    writeFileSync(src, job.html);
    const target = join(out, job.file);
    execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--user-data-dir=${join(temp, 'profile')}`,
        `--window-size=${job.width},${job.height}`,
        `--screenshot=${target}`,
        pathToFileURL(src).href,
      ],
      { stdio: 'pipe', timeout: 60_000 },
    );
    console.log(`public/${job.file}  ${job.width}×${job.height}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
