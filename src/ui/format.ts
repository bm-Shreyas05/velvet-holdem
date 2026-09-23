import type { ActionLogEntry, HandEvent } from '../engine/types.ts';

const nf = new Intl.NumberFormat('en-US');

export function chips(n: number): string {
  return nf.format(Math.round(n));
}

export function pct(x: number | null, digits = 0): string {
  return x === null ? '—' : `${(x * 100).toFixed(digits)}%`;
}

export function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${chips(r)}` : r < 0 ? `−${chips(-r)}` : '0';
}

export type Tone = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin' | 'post' | 'win' | 'muck';

export interface ActionBadge {
  label: string;
  tone: Tone;
}

/** Short label for the bubble next to a player ("Raise 300", "All-in 1,250"). */
export function actionBadge(e: Extract<HandEvent, { type: 'action' }>): ActionBadge {
  if (e.allIn && e.kind !== 'fold' && e.kind !== 'check') return { label: `All-in ${chips(e.to)}`, tone: 'allin' };
  switch (e.kind) {
    case 'fold':
      return { label: 'Fold', tone: 'fold' };
    case 'check':
      return { label: 'Check', tone: 'check' };
    case 'call':
      return { label: `Call ${chips(e.amount)}`, tone: 'call' };
    case 'bet':
      return { label: `Bet ${chips(e.to)}`, tone: 'bet' };
    case 'raise':
      return { label: `Raise to ${chips(e.to)}`, tone: 'raise' };
  }
}

/** Sentence for the table log and screen readers ("Rico raises to 300", "You call 100"). */
export function actionSentence(name: string, e: Pick<ActionLogEntry, 'kind' | 'amount' | 'to' | 'allIn'>): string {
  const you = name === 'You';
  const v = (third: string, second: string) => (you ? second : third);
  switch (e.kind) {
    case 'fold':
      return `${name} ${v('folds', 'fold')}`;
    case 'check':
      return `${name} ${v('checks', 'check')}`;
    case 'call':
      return e.allIn ? `${name} ${v('calls', 'call')} ${chips(e.amount)} and ${v('is', 'are')} all-in` : `${name} ${v('calls', 'call')} ${chips(e.amount)}`;
    case 'bet':
      return e.allIn ? `${name} ${v('bets', 'bet')} ${chips(e.to)}, all-in` : `${name} ${v('bets', 'bet')} ${chips(e.to)}`;
    case 'raise':
      return e.allIn ? `${name} ${v('raises', 'raise')} to ${chips(e.to)}, all-in` : `${name} ${v('raises', 'raise')} to ${chips(e.to)}`;
    case 'small-blind':
      return `${name} ${v('posts', 'post')} the small blind (${chips(e.amount)})`;
    case 'big-blind':
      return `${name} ${v('posts', 'post')} the big blind (${chips(e.amount)})`;
    case 'ante':
      return `${name} ${v('posts', 'post')} an ante (${chips(e.amount)})`;
  }
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
