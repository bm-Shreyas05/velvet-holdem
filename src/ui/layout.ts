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

export function chooseOrientation(width: number, height: number): Orientation {
  return width / Math.max(1, height) < 0.9 ? 'portrait' : 'landscape';
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
