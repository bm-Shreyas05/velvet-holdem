/**
 * Casino chips. Colours follow the common convention (5 red, 25 green, 100 black, 500 purple,
 * 1,000 yellow…) so a stack reads its value at a glance; the exact amount is always printed
 * beside it as well.
 */
export interface Denomination {
  value: number;
  body: string;
  stripe: string;
}

export const DENOMINATIONS: Denomination[] = [
  { value: 100000, body: '#2c6fb3', stripe: '#f4efe2' },
  { value: 25000, body: '#1f8087', stripe: '#f4efe2' },
  { value: 5000, body: '#cf6a27', stripe: '#1c1c1e' },
  { value: 1000, body: '#d8ae3f', stripe: '#232327' },
  { value: 500, body: '#6a3f9c', stripe: '#f4efe2' },
  { value: 100, body: '#26272b', stripe: '#f4efe2' },
  { value: 25, body: '#2f8150', stripe: '#f4efe2' },
  { value: 5, body: '#b93030', stripe: '#f4efe2' },
  { value: 1, body: '#eeeae0', stripe: '#3d6fb4' },
];

/** Greedy breakdown into chips, largest first: [[denomination, count], …]. */
export function breakdown(amount: number): [Denomination, number][] {
  const out: [Denomination, number][] = [];
  let left = Math.max(0, Math.floor(amount));
  for (const d of DENOMINATIONS) {
    const n = Math.floor(left / d.value);
    if (n > 0) {
      out.push([d, n]);
      left -= n * d.value;
    }
  }
  return out;
}

const CHIP_W = 34;
const CHIP_H = 6;
const MAX_PER_COLUMN = 9;

function chipSide(d: Denomination, x: number, y: number): string {
  // Side view: a short cylinder with edge inserts.
  const inserts = [4, 13, 22].map((dx) => `<rect x="${x + dx}" y="${y + 1}" width="6" height="${CHIP_H - 2}" fill="${d.stripe}" opacity="0.9"/>`).join('');
  return `<rect x="${x}" y="${y}" width="${CHIP_W}" height="${CHIP_H}" rx="2.5" fill="${d.body}" stroke="rgba(0,0,0,.45)" stroke-width="0.8"/>${inserts}`;
}

function chipTop(d: Denomination, x: number, y: number): string {
  const cx = x + CHIP_W / 2;
  const cy = y;
  return `<ellipse cx="${cx}" cy="${cy}" rx="${CHIP_W / 2}" ry="6" fill="${d.body}" stroke="rgba(0,0,0,.45)" stroke-width="0.8"/>
  <ellipse cx="${cx}" cy="${cy}" rx="${CHIP_W / 2 - 5}" ry="3.6" fill="none" stroke="${d.stripe}" stroke-width="1.4" stroke-dasharray="3 3"/>`;
}

/**
 * SVG of up to three side-by-side columns of chips making `amount`. Very large amounts are
 * capped visually (the label carries the exact figure).
 */
export function chipStackSvg(amount: number): { svg: string; width: number; height: number } {
  const parts = breakdown(amount);
  const columns: Denomination[][] = [];
  for (const [d, n] of parts) {
    let count = Math.min(n, MAX_PER_COLUMN);
    while (count > 0 && columns.length < 3) {
      const take = Math.min(count, MAX_PER_COLUMN);
      columns.push(new Array(take).fill(d));
      count -= take;
    }
    if (columns.length >= 3) break;
  }
  const gap = 4;
  const width = Math.max(1, columns.length) * (CHIP_W + gap);
  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const height = tallest * CHIP_H + 14;
  let body = '';
  columns.forEach((col, i) => {
    const x = i * (CHIP_W + gap) + 1;
    col.forEach((d, k) => {
      const y = height - 8 - (k + 1) * CHIP_H;
      body += chipSide(d, x, y);
      if (k === col.length - 1) body += chipTop(d, x, y);
    });
  });
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width + 2} ${height}" width="${width + 2}" height="${height}" aria-hidden="true">${body}</svg>`,
    width: width + 2,
    height,
  };
}

/** A single flat chip (top view), used for the pot icon and flying-chip animations. */
export function chipTopSvg(value: number, size = 26): string {
  const d = DENOMINATIONS.find((x) => value >= x.value) ?? DENOMINATIONS[DENOMINATIONS.length - 1]!;
  const r = size / 2;
  const spokes = Array.from({ length: 6 }, (_, i) => {
    const a = (i * Math.PI) / 3;
    const x = r + Math.cos(a) * (r - 3);
    const y = r + Math.sin(a) * (r - 3);
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${(size / 11).toFixed(2)}" fill="${d.stripe}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
  <circle cx="${r}" cy="${r}" r="${r - 0.5}" fill="${d.body}" stroke="rgba(0,0,0,.5)"/>${spokes}
  <circle cx="${r}" cy="${r}" r="${r * 0.55}" fill="${d.body}" stroke="${d.stripe}" stroke-width="1.2"/></svg>`;
}
