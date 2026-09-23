import { App } from './ui/app.ts';
import { toast } from './ui/dialogs.ts';

function fatal(root: HTMLElement, error: unknown): void {
  console.error(error);
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML =
    '<h1>Velvet could not start</h1><p>Something prevented the game from loading. Reloading the page usually fixes this. If it keeps happening, your browser may be blocking scripts or storage for this page.</p>';
  const btn = document.createElement('button');
  btn.className = 'btn btn--primary';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  box.append(btn);
  root.append(box);
}

function boot(): void {
  const root = document.getElementById('app');
  if (!root) return;
  try {
    const app = new App(root);
    app.showMenu();
    let reported = 0;
    const report = (message: string) => {
      console.error(message);
      if (reported++ < 2) toast('Something went wrong. Your game is saved; if the table stops responding, leave and continue from the menu.', 'error');
    };
    window.addEventListener('error', (e) => report(e.message));
    window.addEventListener('unhandledrejection', (e) => report(String(e.reason)));
  } catch (error) {
    fatal(root, error);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
