/**
 * Builds the game into self-contained HTML:
 *   dist/index.html     — full document; open it directly or serve it (npm start)
 *   dist/artifact.html  — the same game as page content (for hosts that supply the document shell)
 * The AI worker is bundled separately and embedded as a string, then started from a Blob URL,
 * so the game is a single file with no external requests.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const common = { bundle: true, write: false, target: 'es2022', minify: !dev, sourcemap: false, logLevel: 'warning', absWorkingDir: root };

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
const html = template.replace('/*INLINE_CSS*/', () => styles).replace('/*INLINE_JS*/', () => js);

const title = "<title>Velvet Hold'em</title>";
const artifact = `${title}\n<style>${styles}</style>\n<div id="app" data-screen="loading"></div>\n<script>${js}</script>\n`;

await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/index.html'), html);
await writeFile(resolve(root, 'dist/artifact.html'), artifact);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`Built dist/index.html (${kb(html.length)}; app ${kb(js.length)}, AI worker ${kb(workerCode.length)}, styles ${kb(styles.length)}) in ${Math.round(performance.now() - t0)} ms`);
