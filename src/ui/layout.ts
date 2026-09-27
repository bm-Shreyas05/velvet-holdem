/**
 * Table geometry in "stage units". The stage is drawn at a fixed design size and scaled to fit
 * the window, so every position and animation path is computed once, in one coordinate system.
 * The human always sits at the bottom centre; other seats follow clockwise.
 */
export type Orientation = 'landscape' | 'portrait';

export interface Point {
  x: number;
  y: number;
}

export interface SeatGeometry {
  anchor: Point;
  /** Where this seat's bet sits on the felt. */
  bet: Point;
  /** Where the dealer button sits when this seat has it. */
  button: Point;
  /** Direction of the table centre from the seat (where the AI's cards peek out). */
  side: 'top' | 'bottom' | 'left' | 'right';
}

export interface StageLayout {
  orientation: Orientation;
  width: number;
  height: number;
  table: { cx: number; cy: number; rx: number; ry: number };
  board: Point;
  pot: Point;
  deck: Point;
  seats: SeatGeometry[];
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Everything drawn on the stage, in stage units. Side seats' name plates reach past the design
 * rectangle (up to ~50 units in landscape), so scaling to the rectangle alone would clip them.
 * Horizontally a seat extends 96 units from its anchor: name plates are capped at 190 units
 * (CSS max-width) whatever the font, plus a unit for rounding. The vertical extents were
 * measured: cards sit above or below the plate depending on which side of the table it faces.
 */
/** Half the widest name plate (.seat-plate max-width: 190px) plus a unit for rounding. */
const PLATE_REACH = 96;

export function contentBounds(layout: StageLayout): Bounds {
  const b: Bounds = { left: 0, top: 0, right: layout.width, bottom: layout.height };
  for (const seat of layout.seats) {
    const { x, y } = seat.anchor;
    const [up, down] = seat.side === 'bottom' ? [50, 50] : seat.side === 'top' ? [80, 76] : [50, 80];
    b.left = Math.min(b.left, x - PLATE_REACH);
    b.right = Math.max(b.right, x + PLATE_REACH);
    b.top = Math.min(b.top, y - up);
    b.bottom = Math.max(b.bottom, y + down);
  }
  return b;
}

/** The largest scale at which the whole layout fits a box of the given size. */
export function fitScale(layout: StageLayout, width: number, height: number): number {
  const b = contentBounds(layout);
  return Math.min(width / (b.right - b.left), height / (b.bottom - b.top));
}

/**
 * Picks the orientation that shows the table larger. A change needs a clear gain (10%), so small
 * resizes — such as the action bar growing on the player's turn — never flip the layout back
 * and forth.
 */
export function chooseOrientation(width: number, height: number, seatCount: number, current: Orientation | null = null): Orientation {
  const fit = (o: Orientation) => fitScale(computeLayout(seatCount, o), width, height);
  const portrait = fit('portrait');
  const landscape = fit('landscape');
  if (current === 'portrait' && landscape < portrait * 1.1) return 'portrait';
  if (current === 'landscape' && portrait < landscape * 1.1) return 'landscape';
  return portrait > landscape ? 'portrait' : 'landscape';
}

export function computeLayout(seatCount: number, orientation: Orientation): StageLayout {
  const landscape = orientation === 'landscape';
  const width = landscape ? 1000 : 640;
  const height = landscape ? 600 : 920;
  const table = landscape ? { cx: 500, cy: 290, rx: 405, ry: 208 } : { cx: 320, cy: 440, rx: 236, ry: 340 };
  const seatRing = landscape ? { rx: 452, ry: 250 } : { rx: 226, ry: 384 };
  const board = { x: table.cx, y: table.cy - (landscape ? 22 : 70) };
  const pot = { x: table.cx, y: table.cy + (landscape ? 58 : 40) };
  const seats: SeatGeometry[] = [];
  for (let i = 0; i < seatCount; i++) {
    const theta = (i / seatCount) * Math.PI * 2;
    const sx = -Math.sin(theta);
    const sy = Math.cos(theta);
    const anchor = { x: table.cx + seatRing.rx * sx, y: table.cy + seatRing.ry * sy };
    const sideways = Math.abs(sy) <= 0.6;
    const side: SeatGeometry['side'] = !sideways ? (sy < 0 ? 'bottom' : 'top') : sx < 0 ? 'right' : 'left';

    // Bets sit on the felt between the seat and the centre, clear of the board and the pot.
    const bet = { x: table.cx + (anchor.x - table.cx) * 0.56, y: table.cy + (anchor.y - table.cy) * 0.56 };
    if (!landscape && sideways) {
      bet.x = table.cx + Math.sign(sx) * 150;
      bet.y = table.cy + 96 + sy * 120;
    }
    if (!landscape && !sideways && sy < 0) bet.y = Math.min(bet.y, board.y - 110);

    // The dealer button sits beside the bet, on the side facing the seat's left hand.
    const button = landscape
      ? { x: table.cx + (anchor.x - table.cx) * 0.72 + -sy * 58, y: table.cy + (anchor.y - table.cy) * 0.72 + sx * 30 }
      : { x: bet.x + (sideways ? Math.sign(sx) * 52 : 64), y: bet.y + (sideways ? -34 : 0) };

    if (i === 0) {
      anchor.x = table.cx;
      anchor.y = landscape ? 532 : 832;
      // The player's own bet sits beside their cards, clear of the pot.
      bet.x = anchor.x + (landscape ? -150 : -132);
      bet.y = landscape ? 440 : 722;
      button.x = anchor.x + (landscape ? 118 : 116);
      button.y = landscape ? 452 : 730;
    }
    seats.push({ anchor, bet, button, side });
  }
  return {
    orientation,
    width,
    height,
    table,
    board,
    pot,
    deck: { x: table.cx, y: table.cy - (landscape ? 118 : 210) },
    seats,
  };
}
