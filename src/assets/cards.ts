import { type Card, RANK_CHARS, rankOf, suitOf } from '../engine/cards.ts';

/**
 * Playing-card artwork, generated as SVG so cards stay crisp at every size and no image files
 * are needed. Suits are drawn as vector paths (never emoji or font glyphs), number cards use the
 * traditional pip layouts, and court cards use a framed panel.
 */

/** Suit shapes in a 100×100 box. Order matches suit indices: clubs, diamonds, hearts, spades. */
export const SUIT_PATHS = [
  // clubs
  'M50 8a19 19 0 0 1 17.6 26.2A19 19 0 1 1 57 66.4C58 80 63 90 70 96H30c7-6 12-16 13-29.6A19 19 0 1 1 32.4 34.2 19 19 0 0 1 50 8Z',
  // diamonds
  'M50 3C58 20 72 37 89 50 72 63 58 80 50 97 42 80 28 63 11 50 28 37 42 20 50 3Z',
  // hearts
  'M50 93C44 86 7 61 7 34 7 18 19 8 32 8c9 0 15 5 18 12 3-7 9-12 18-12 13 0 25 10 25 26 0 27-37 52-43 59Z',
  // spades
  'M50 4c6 11 38 33 38 57 0 14-10 23-22 23-7 0-12-3-14-7 1 9 5 15 12 19H36c7-4 11-10 12-19-2 4-7 7-14 7-12 0-22-9-22-23C12 37 44 15 50 4Z',
] as const;

export const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'] as const;

export interface CardStyle {
  fourColor: boolean;
}

export function suitColor(suit: number, fourColor: boolean): string {
  if (fourColor) return ['#1f7a3d', '#1d5fc0', '#c3262e', '#1b1b1e'][suit]!;
  return suit === 1 || suit === 2 ? '#c3262e' : '#1b1b1e';
}

function pip(suit: number, x: number, y: number, size: number, color: string, flip = false): string {
  const s = size / 100;
  const t = `translate(${x - size / 2} ${y - size / 2}) scale(${s})`;
  const rot = flip ? ` rotate(180 ${x} ${y})` : '';
  return `<path d="${SUIT_PATHS[suit]}" fill="${color}" transform="${rot.trim()} ${t}"/>`;
}

const L = 82;
const C = 125;
const R = 168;
/** Classic pip layouts for 2–10 (x, y). Pips in the lower half are drawn upside down. */
const LAYOUTS: Record<number, [number, number][]> = {
  2: [[C, 88], [C, 262]],
  3: [[C, 88], [C, 175], [C, 262]],
  4: [[L, 88], [R, 88], [L, 262], [R, 262]],
  5: [[L, 88], [R, 88], [C, 175], [L, 262], [R, 262]],
  6: [[L, 88], [R, 88], [L, 175], [R, 175], [L, 262], [R, 262]],
  7: [[L, 88], [R, 88], [C, 131], [L, 175], [R, 175], [L, 262], [R, 262]],
  8: [[L, 88], [R, 88], [C, 131], [L, 175], [R, 175], [C, 219], [L, 262], [R, 262]],
  9: [[L, 88], [R, 88], [L, 146], [R, 146], [C, 175], [L, 204], [R, 204], [L, 262], [R, 262]],
  10: [[L, 88], [R, 88], [C, 117], [L, 146], [R, 146], [L, 204], [R, 204], [C, 233], [L, 262], [R, 262]],
};

const SERIF = "'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif";

function rankLabel(rank: number): string {
  return rank === 8 ? '10' : RANK_CHARS[rank]!;
}

function corner(rank: number, suit: number, color: string): string {
  const label = rankLabel(rank);
  const size = label.length > 1 ? 40 : 46;
  const text = `<text x="30" y="54" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${size}" fill="${color}" ${label.length > 1 ? 'letter-spacing="-3"' : ''}>${label}</text>`;
  return `<g>${text}${pip(suit, 30, 78, 30, color)}</g>`;
}

function courtPanel(rank: number, suit: number, color: string): string {
  const letter = RANK_CHARS[rank]!;
  const frame = '#b58b3b';
  // King and queen wear a crown, the jack a plumed cap.
  const crown =
    rank >= 10
      ? `<path d="M100 132l12 16 13-22 13 22 12-16-6 30h-38z" fill="${frame}" opacity="0.9"/>`
      : `<path d="M108 158c2-16 16-24 34-20-6 3-9 8-10 14l6 8h-30z" fill="${frame}" opacity="0.9"/>`;
  return `
    <rect x="54" y="54" width="142" height="242" rx="10" fill="${color}" fill-opacity="0.06" stroke="${frame}" stroke-width="3"/>
    <rect x="62" y="62" width="126" height="226" rx="7" fill="none" stroke="${frame}" stroke-opacity="0.5" stroke-width="1.5"/>
    ${pip(suit, 125, 96, 34, color)}
    ${pip(suit, 125, 254, 34, color, true)}
    ${crown}
    <text x="125" y="222" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="92" fill="${color}">${letter}</text>`;
}

export function cardFaceSvg(card: Card, style: CardStyle): string {
  const rank = rankOf(card);
  const suit = suitOf(card);
  const color = suitColor(suit, style.fourColor);
  let center = '';
  if (rank === 12) {
    center = pip(suit, 125, 175, suit === 3 ? 120 : 100, color);
    if (suit === 3) center += `<circle cx="125" cy="175" r="72" fill="none" stroke="${color}" stroke-opacity="0.18" stroke-width="2"/>`;
  } else if (rank >= 9) {
    center = courtPanel(rank, suit, color);
  } else {
    const count = rank + 2;
    center = LAYOUTS[count]!.map(([x, y]) => pip(suit, x, y, 44, color, y > 175)).join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350">
  <rect x="2" y="2" width="246" height="346" rx="20" fill="#fbf9f3" stroke="#d6cfc1" stroke-width="3"/>
  ${corner(rank, suit, color)}
  <g transform="rotate(180 125 175)">${corner(rank, suit, color)}</g>
  ${center}
</svg>`;
}

export const CARD_BACKS = {
  claret: { base: '#6e1d2b', dark: '#4d1420', line: '#d4b06a' },
  midnight: { base: '#1d2c4d', dark: '#121c33', line: '#c9b27a' },
} as const;

export function cardBackSvg(back: keyof typeof CARD_BACKS): string {
  const c = CARD_BACKS[back];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350">
  <defs>
    <pattern id="lattice" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="22" height="22" fill="${c.base}"/>
      <path d="M0 11h22M11 0v22" stroke="${c.line}" stroke-opacity="0.35" stroke-width="1.4"/>
      <circle cx="11" cy="11" r="2.2" fill="${c.line}" fill-opacity="0.45"/>
    </pattern>
  </defs>
  <rect x="2" y="2" width="246" height="346" rx="20" fill="#f6f2e8" stroke="#d6cfc1" stroke-width="3"/>
  <rect x="16" y="16" width="218" height="318" rx="12" fill="url(#lattice)"/>
  <rect x="16" y="16" width="218" height="318" rx="12" fill="none" stroke="${c.dark}" stroke-width="4"/>
  <rect x="28" y="28" width="194" height="294" rx="8" fill="none" stroke="${c.line}" stroke-opacity="0.7" stroke-width="2"/>
  <g transform="translate(125 175)">
    <ellipse rx="44" ry="58" fill="${c.dark}" stroke="${c.line}" stroke-width="2.5"/>
    <text y="16" text-anchor="middle" font-family="${SERIF}" font-style="italic" font-size="46" fill="${c.line}">V</text>
  </g>
</svg>`;
}

const cache = new Map<string, string>();

export function toDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/\s{2,}/g, ' '))}`;
}

export function cardFaceUrl(card: Card, style: CardStyle): string {
  const key = `f${card}${style.fourColor ? 'c' : ''}`;
  let url = cache.get(key);
  if (!url) {
    url = toDataUrl(cardFaceSvg(card, style));
    cache.set(key, url);
  }
  return url;
}

export function cardBackUrl(back: keyof typeof CARD_BACKS): string {
  const key = `b${back}`;
  let url = cache.get(key);
  if (!url) {
    url = toDataUrl(cardBackSvg(back));
    cache.set(key, url);
  }
  return url;
}
