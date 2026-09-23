import { ICONS } from '../assets/icons.ts';
import { h } from './dom.ts';

/**
 * Modal sheets, confirmations and toasts. Every dialog traps focus, closes with Escape (unless it
 * demands a choice), restores focus to where it came from, and is announced to screen readers.
 */
export interface SheetHandle {
  close(): void;
  readonly element: HTMLElement;
  readonly body: HTMLElement;
}

interface SheetOptions {
  title: string;
  wide?: boolean;
  /** Dialog must be answered: no close button, Escape does nothing. */
  modal?: boolean;
  onClose?: () => void;
  className?: string;
}

const stack: { el: HTMLElement; opts: SheetOptions; restore: Element | null; close: () => void }[] = [];

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.hidden && el.offsetParent !== null,
  );
}

document.addEventListener(
  'keydown',
  (e) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape' && !top.opts.modal) {
      e.preventDefault();
      e.stopPropagation();
      top.close();
    } else if (e.key === 'Tab') {
      const items = focusables(top.el);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  },
  true,
);

export function dialogOpen(): boolean {
  return stack.length > 0;
}

export function openSheet(opts: SheetOptions, ...content: (Node | string)[]): SheetHandle {
  const titleId = `sheet-title-${Math.random().toString(36).slice(2, 8)}`;
  const body = h('div', { class: 'sheet-body' }, ...content);
  const header = h('header', { class: 'sheet-head' }, h('h2', { id: titleId, class: 'sheet-title' }, opts.title));
  const panel = h('div', { class: `sheet ${opts.wide ? 'sheet--wide' : ''} ${opts.className ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, header, body);
  const backdrop = h('div', { class: 'sheet-backdrop' }, panel);
  const restore = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const i = stack.findIndex((s) => s.el === panel);
    if (i >= 0) stack.splice(i, 1);
    backdrop.classList.add('is-leaving');
    setTimeout(() => backdrop.remove(), 160);
    if (restore instanceof HTMLElement && document.contains(restore)) restore.focus({ preventScroll: true });
    opts.onClose?.();
  };
  if (!opts.modal) {
    const x = h('button', { type: 'button', class: 'icon-btn sheet-close', 'aria-label': 'Close', title: 'Close (Esc)', html: ICONS.close });
    x.addEventListener('click', close);
    header.append(x);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
  }
  document.body.append(backdrop);
  stack.push({ el: panel, opts, restore, close });
  requestAnimationFrame(() => {
    const first = focusables(panel).find((el) => !el.classList.contains('sheet-close')) ?? focusables(panel)[0];
    (first ?? panel).focus({ preventScroll: true });
  });
  return { close, element: panel, body };
}

export interface Choice<T extends string> {
  id: T;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export function choose<T extends string>(title: string, message: string | Node, choices: Choice<T>[], opts: { modal?: boolean; cancelId?: T } = {}): Promise<T> {
  return new Promise((resolve) => {
    let answered = false;
    const buttons = h(
      'div',
      { class: 'sheet-actions' },
      ...choices.map((c) => {
        const b = h('button', { type: 'button', class: `btn ${c.primary ? 'btn--primary' : ''} ${c.danger ? 'btn--danger' : ''}` }, c.label);
        b.addEventListener('click', () => {
          answered = true;
          sheet.close();
          resolve(c.id);
        });
        return b;
      }),
    );
    const sheet = openSheet(
      {
        title,
        modal: opts.modal ?? opts.cancelId === undefined,
        onClose: () => {
          if (!answered && opts.cancelId !== undefined) resolve(opts.cancelId);
        },
      },
      typeof message === 'string' ? h('p', { class: 'sheet-message' }, message) : message,
      buttons,
    );
  });
}

export async function confirm(title: string, message: string, confirmLabel: string, danger = false): Promise<boolean> {
  const answer = await choose(title, message, [
    { id: 'cancel', label: 'Cancel' },
    { id: 'ok', label: confirmLabel, primary: !danger, danger },
  ], { cancelId: 'cancel' });
  return answer === 'ok';
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, tone: 'info' | 'warning' | 'error' = 'info', ms = 3800): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast toast--${tone}` }, message);
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 250);
  }, tone === 'error' ? ms * 2 : ms);
}

/** Screen-reader announcements (visually hidden live regions). */
export class Announcer {
  #polite: HTMLElement;
  #assertive: HTMLElement;
  enabled = true;
  constructor() {
    this.#polite = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.#assertive = h('div', { class: 'sr-only', 'aria-live': 'assertive', 'aria-atomic': 'true' });
    document.body.append(this.#polite, this.#assertive);
  }
  say(text: string, urgent = false): void {
    if (!this.enabled) return;
    const el = urgent ? this.#assertive : this.#polite;
    el.textContent = '';
    requestAnimationFrame(() => (el.textContent = text));
  }
}
