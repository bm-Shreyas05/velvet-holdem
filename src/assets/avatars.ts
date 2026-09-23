import type { StyleId } from '../ai/profiles.ts';

/**
 * Player portraits: a monogram medallion whose colour and emblem encode the playing style, so
 * opponents are recognisable at a glance (and not by colour alone — each style has its own mark).
 */
const STYLE_ART: Record<StyleId | 'human', { from: string; to: string; mark: string }> = {
  human: { from: '#c9a45c', to: '#7d6230', mark: '<circle cx="50" cy="80" r="4" fill="rgba(255,255,255,.55)"/>' },
  shark: { from: '#3f7f8c', to: '#1c3f47', mark: '<path d="M38 84l12-10 12 10z" fill="rgba(255,255,255,.55)"/>' },
  maniac: { from: '#c2453a', to: '#6a1c18', mark: '<path d="M44 76l10-4-4 7 8-1-12 9 4-7-7 1z" fill="rgba(255,255,255,.6)"/>' },
  rock: { from: '#6d7a8c', to: '#343c48', mark: '<rect x="43" y="76" width="14" height="10" rx="2" fill="rgba(255,255,255,.5)"/>' },
  station: { from: '#c28a2e', to: '#6b4913', mark: '<circle cx="50" cy="81" r="6" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="2.5"/>' },
  trapper: { from: '#7a57a8', to: '#3a2658', mark: '<path d="M42 86l8-14 8 14z" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="2.5"/>' },
};

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

export function avatarSvg(name: string, style: StyleId | null): string {
  const art = STYLE_ART[style ?? 'human'];
  const id = `g${Math.abs([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}${style ?? 'h'}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true">
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${art.from}"/><stop offset="1" stop-color="${art.to}"/></linearGradient></defs>
  <circle cx="50" cy="50" r="48" fill="url(#${id})"/>
  <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1.5"/>
  <text x="50" y="61" text-anchor="middle" font-family="'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif" font-size="34" font-weight="700" fill="#fff" fill-opacity=".94">${initials(name).replace(/[<&>"]/g, '')}</text>
  ${art.mark}
</svg>`;
}
