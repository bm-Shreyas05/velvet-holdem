/**
 * Court-card figures (jack, queen, king), drawn as SVG in the traditional double-ended way: the
 * upper figure is mirrored below a centre line so the card reads the same either way up. Each
 * rank has its own headwear, hair and emblem; the suit sets the robe's colours.
 *
 * Coordinates are in the 250 × 350 card face; the figure fills the framed panel (x 54–196,
 * y 54–296) whose centre line is y = 175.
 */

const GOLD = '#c39a45';
const GOLD_LIGHT = '#e3c47a';
const SKIN = '#f3d9bd';
const INK = '#2a2124';

/** Second robe colour, chosen to sit well beside each suit colour. */
function accentFor(suit: number, fourColor: boolean): string {
  if (fourColor) return ['#2c4f7c', '#7c2c3b', '#2c4f7c', '#7c2c3b'][suit]!;
  return suit === 1 || suit === 2 ? '#2c4f7c' : '#9b2f36';
}

const HAIR = { 9: '#4a3326', 10: '#9a5a32', 11: '#d8d2c4' } as Record<number, string>;

/** Robe, collar and the band of pips down the front (shared by all ranks). */
function robe(color: string, accent: string): string {
  return `
    <path d="M62 175 L70 147 Q125 120 180 147 L188 175 Z" fill="${accent}"/>
    <path d="M70 147 Q125 120 180 147 L176 158 Q125 134 74 158 Z" fill="${GOLD}"/>
    <path d="M112 133 L125 175 L138 133 Q125 128 112 133 Z" fill="${color}"/>
    <path d="M118 139 L125 160 L132 139" fill="none" stroke="${GOLD_LIGHT}" stroke-width="1.6"/>
    <path d="M62 175 L64 168 L186 168 L188 175 Z" fill="${color}" opacity="0.55"/>
    <path d="M64 168 L186 168" stroke="${GOLD_LIGHT}" stroke-width="1.2"/>`;
}

function face(cx: number, cy: number): string {
  return `
    <rect x="${cx - 6}" y="${cy + 14}" width="12" height="10" fill="${SKIN}"/>
    <ellipse cx="${cx}" cy="${cy}" rx="15" ry="18" fill="${SKIN}"/>
    <circle cx="${cx - 5.5}" cy="${cy - 1}" r="1.7" fill="${INK}"/>
    <circle cx="${cx + 5.5}" cy="${cy - 1}" r="1.7" fill="${INK}"/>
    <path d="M${cx} ${cy + 1} L${cx - 1.6} ${cy + 6} L${cx + 1} ${cy + 6}" fill="none" stroke="#c49a7d" stroke-width="1.2"/>
    <path d="M${cx - 4} ${cy + 10} Q${cx} ${cy + 12.5} ${cx + 4} ${cy + 10}" fill="none" stroke="#a5534a" stroke-width="1.4" stroke-linecap="round"/>`;
}

function king(color: string, accent: string): string {
  const hair = HAIR[11]!;
  return `
    ${robe(color, accent)}
    <path d="M101 96 Q99 118 108 128 L142 128 Q151 118 149 96 Z" fill="${hair}"/>
    ${face(125, 108)}
    <path d="M110 114 Q112 134 125 138 Q138 134 140 114 Q134 124 125 125 Q116 124 110 114 Z" fill="${hair}"/>
    <path d="M117 118 Q125 114 133 118" fill="none" stroke="${hair}" stroke-width="3" stroke-linecap="round"/>
    <path d="M104 94 L106 74 L114 84 L120 70 L125 82 L130 70 L136 84 L144 74 L146 94 Z" fill="${GOLD}" stroke="#8a6a2a" stroke-width="1"/>
    <rect x="104" y="89" width="42" height="7" fill="${GOLD_LIGHT}"/>
    <circle cx="125" cy="92.5" r="2.6" fill="${color}"/>
    <circle cx="114" cy="92.5" r="1.8" fill="${accent}"/>
    <circle cx="136" cy="92.5" r="1.8" fill="${accent}"/>
    <path d="M158 92 L158 166" stroke="#9aa3ad" stroke-width="4" stroke-linecap="round"/>
    <path d="M150 150 L166 150" stroke="${GOLD}" stroke-width="4" stroke-linecap="round"/>
    <circle cx="158" cy="160" r="3" fill="${GOLD}"/>`;
}

function queen(color: string, accent: string): string {
  const hair = HAIR[10]!;
  return `
    ${robe(color, accent)}
    <path d="M104 100 Q98 130 104 150 L114 148 Q109 128 112 108 Z" fill="${hair}"/>
    <path d="M146 100 Q152 130 146 150 L136 148 Q141 128 138 108 Z" fill="${hair}"/>
    <path d="M108 104 Q125 84 142 104 Q138 94 125 92 Q112 94 108 104 Z" fill="${hair}"/>
    ${face(125, 110)}
    <path d="M109 96 L111 80 L118 88 L125 76 L132 88 L139 80 L141 96 Z" fill="${GOLD}" stroke="#8a6a2a" stroke-width="1"/>
    <circle cx="125" cy="88" r="2.6" fill="${color}"/>
    <circle cx="111" cy="80" r="1.6" fill="${GOLD_LIGHT}"/>
    <circle cx="139" cy="80" r="1.6" fill="${GOLD_LIGHT}"/>
    <path d="M90 166 Q88 140 94 126" stroke="#3f7a3a" stroke-width="2.4" fill="none"/>
    <g transform="translate(94 122)">
      <circle r="5" cx="0" cy="-6" fill="${color}"/><circle r="5" cx="6" cy="0" fill="${color}"/>
      <circle r="5" cx="0" cy="6" fill="${color}"/><circle r="5" cx="-6" cy="0" fill="${color}"/>
      <circle r="3.4" fill="${GOLD_LIGHT}"/>
    </g>`;
}

function jack(color: string, accent: string): string {
  const hair = HAIR[9]!;
  return `
    ${robe(color, accent)}
    <path d="M107 106 Q104 126 112 132 L138 132 Q146 126 143 106 Z" fill="${hair}"/>
    ${face(125, 111)}
    <path d="M104 100 Q108 84 128 84 Q148 86 150 98 Q138 94 126 95 Q112 96 104 100 Z" fill="${accent}"/>
    <path d="M102 101 Q126 92 152 100" fill="none" stroke="${GOLD}" stroke-width="3" stroke-linecap="round"/>
    <path d="M146 92 Q168 70 176 60 Q166 80 150 96 Z" fill="${color}"/>
    <path d="M148 94 Q164 76 172 66" fill="none" stroke="${GOLD_LIGHT}" stroke-width="1.2"/>
    <path d="M92 168 L92 98" stroke="#7a5a3a" stroke-width="3" stroke-linecap="round"/>
    <path d="M92 96 L84 108 L92 104 L100 108 Z" fill="#9aa3ad"/>`;
}

/** The figure panel for a court card (rank 9 = jack, 10 = queen, 11 = king). */
export function courtFigure(rank: number, suit: number, color: string, fourColor: boolean, pip: (x: number, y: number, size: number) => string): string {
  const accent = accentFor(suit, fourColor);
  const half = rank === 11 ? king(color, accent) : rank === 10 ? queen(color, accent) : jack(color, accent);
  const id = `court-${rank}-${suit}-${fourColor ? 'c' : 'n'}`;
  return `
    <defs><clipPath id="${id}"><rect x="56" y="56" width="138" height="238" rx="9"/></clipPath></defs>
    <rect x="54" y="54" width="142" height="242" rx="10" fill="#fffdf6" stroke="${GOLD}" stroke-width="3"/>
    <g clip-path="url(#${id})">
      <rect x="56" y="56" width="138" height="238" fill="${color}" fill-opacity="0.07"/>
      <g transform="translate(125 175) scale(1.1) translate(-125 -175)">${half}</g>
      <g transform="rotate(180 125 175) translate(125 175) scale(1.1) translate(-125 -175)">${half}</g>
    </g>
    <path d="M58 175 L192 175" stroke="${GOLD}" stroke-width="1.6"/>
    <rect x="62" y="62" width="126" height="226" rx="7" fill="none" stroke="${GOLD}" stroke-opacity="0.45" stroke-width="1.2"/>
    ${pip(76, 76, 18)}
    <g transform="rotate(180 125 175)">${pip(76, 76, 18)}</g>`;
}
