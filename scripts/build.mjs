/**
 * Builds the game into self-contained HTML:
 *   dist/index.html     — full document; open it directly or serve it (npm start)
 *   dist/artifact.html  — the same game as page content (for hosts that supply the document shell)
 * The AI worker is bundled separately and embedded as a string, then started from a Blob URL,
 * so the game is a single file with no external requests.
 *
 * For web hosting, dist/ also receives the files in public/ (manifest, icons, social image) and a
 * service worker whose version is a hash of the built page. Set SITE_URL (e.g.
 * https://example.github.io/velvet-holdem/) to emit the absolute URLs link previews require.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
// Oldest browsers supported (color-mix() sets the floor). Naming real engines lets esbuild add
// vendor prefixes (e.g. -webkit-backdrop-filter for Safari before 18) and lower newer syntax.
const browsers = ['chrome111', 'edge111', 'firefox113', 'safari16.2', 'ios16.2'];
const common = { bundle: true, write: false, target: browsers, minify: !dev, sourcemap: false, logLevel: 'warning', absWorkingDir: root };

const t0 = performance.now();
const worker = await build({ ...common, entryPoints: ['src/ai/worker.ts'], format: 'iife' });
const workerCode = worker.outputFiles[0].text;
const app = await build({
  ...common,
  entryPoints: ['src/main.ts'],
  format: 'iife',
  define: { __AI_WORKER_SOURCE__: JSON.stringify(workerCode) },
});
const css = await build({ ...common, entryPoints: ['src/styles/main.css'], loader: { '.css': 'css' } });

const js = app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const styles = css.outputFiles[0].text;
const template = await readFile(resolve(root, 'src/index.html'), 'utf8');
const escapeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const siteUrl = process.env.SITE_URL ? new URL(process.env.SITE_URL.replace(/\/?$/, '/')).href : '';
const siteMeta = siteUrl
  ? [
      `<link rel="canonical" href="${escapeAttr(siteUrl)}">`,
      `<meta property="og:url" content="${escapeAttr(siteUrl)}">`,
      `<meta property="og:image" content="${escapeAttr(new URL('og-image.png', siteUrl).href)}">`,
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      `<meta property="og:image:alt" content="Velvet Hold'em — a royal flush fanned on a green table">`,
    ].join('\n')
  : '<meta property="og:image" content="og-image.png">';
const html = template
  .replace('<!--SITE_META-->', () => siteMeta)
  .replace('/*INLINE_CSS*/', () => styles)
  .replace('/*INLINE_JS*/', () => js);

const title = "<title>Velvet Hold'em</title>";
const artifact = `${title}\n<style>${styles}</style>\n<div id="app" data-screen="loading"></div>\n<script>${js}</script>\n`;

await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/index.html'), html);
await writeFile(resolve(root, 'dist/artifact.html'), artifact);

// Web hosting: static assets plus a service worker that precaches this exact build.
await cp(resolve(root, 'public'), resolve(root, 'dist'), { recursive: true });
const assets = ['./', ...(await readdir(resolve(root, 'public'))).filter((f) => f !== 'og-image.png').sort()];
const hash = createHash('sha256').update(html);
for (const file of assets.slice(1)) hash.update(file).update(await readFile(resolve(root, 'public', file)));
const version = hash.digest('hex').slice(0, 12);
const sw = (await readFile(resolve(root, 'src/pwa/sw.js'), 'utf8')).replaceAll('__VERSION__', version).replaceAll('__ASSETS__', JSON.stringify(assets));
await writeFile(resolve(root, 'dist/sw.js'), sw);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `Built dist/index.html (${kb(html.length)}; app ${kb(js.length)}, AI worker ${kb(workerCode.length)}, styles ${kb(styles.length)}), service worker ${version}${siteUrl ? ` for ${siteUrl}` : ''} in ${Math.round(performance.now() - t0)} ms`,
);
