/**
 * Installable-app support: registers the service worker (offline play) and keeps the browser's
 * install prompt so the menu can offer "Install app".
 *
 * Only active on pages that link a web-app manifest and are served over HTTPS (or localhost with
 * ?sw), so opening dist/index.html from disk or embedding the artifact build never registers a
 * worker, and local development never serves stale cached builds.
 */
import { toast } from './dialogs.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

function eligible(): boolean {
  if (!('serviceWorker' in navigator) || !document.querySelector('link[rel="manifest"]')) return false;
  if (location.protocol === 'https:') return true;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return local && new URLSearchParams(location.search).has('sw');
}

export function initPwa(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
  if (!eligible()) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install takes control silently; later changes mean a new version was downloaded.
    if (hadController) toast('A new version of Velvet is ready. Reload the page when convenient to use it — your game is saved.', 'info');
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Offline support unavailable:', error));
  });
}

/** True when the browser has offered to install the game and it is not installed yet. */
export function canInstall(): boolean {
  return deferred !== null;
}

export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (!event) return;
  deferred = null;
  notify();
  await event.prompt();
  await event.userChoice.catch(() => undefined);
}

export function onInstallAvailabilityChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
