import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, process.argv.includes('--evaluate') ? 'test-output/replay-site' :
  process.argv.includes('--stress') ? 'test-output/stress-site' :
  process.argv.includes('--browser-test') ? 'test-output/browser-site' : 'dist');
const pins = JSON.parse(await readFile(resolve(root, 'asset-pins.json'), 'utf8'));
const lessonPins = JSON.parse(await readFile(resolve(root, 'public/lesson-credits.json'), 'utf8'));
const digest = b => createHash('sha256').update(b).digest('hex');
if (lessonPins.length !== 10 || new Set(lessonPins.map(item => item.word)).size !== 10) throw new Error('Expected ten distinct teaching clips.');
for (const asset of [...pins, ...lessonPins.map(item => ({ ...item, path: 'lessons/' + item.word.toLowerCase() + '.mp4' }))]) {
  const bytes = await readFile(resolve(root, 'public', asset.path));
  if (digest(bytes) !== asset.sha256) throw new Error('Build asset fingerprint mismatch: ' + asset.path);
}
// Build into a staging directory and swap at the end: a build that fails halfway used to leave a
// dist without main.mjs, which renders as a styled but dead page with no error anywhere.
const staging = out + '.staging';
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(resolve(root, 'public'), staging, { recursive: true });
const vision = resolve(root, 'node_modules/@mediapipe/tasks-vision');
const ort = resolve(root, 'node_modules/onnxruntime-web/dist');
await cp(resolve(vision, 'wasm'), resolve(staging, 'vision'), {
  recursive: true, filter: path => !path.includes('_module_internal')
});
await mkdir(resolve(staging, 'ort'));
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await cp(resolve(ort, name), resolve(staging, 'ort', name));
}
const cfg = { absWorkingDir: root, bundle: true, minify: true, platform: 'browser', target: 'es2022', logLevel: 'warning' };
await build({ ...cfg, entryPoints: ['src/main.mjs', 'src/classifier.mjs'], outdir: staging, format: 'esm', outExtension: { '.js': '.mjs' } });
await build({ ...cfg, entryPoints: ['src/tracker.mjs'], outfile: resolve(staging, 'tracker.js'), format: 'iife' });
if (process.argv.includes('--evaluate')) {
  await cp(resolve(root, 'scripts/replay.html'), resolve(staging, 'replay.html'));
  await build({ ...cfg, entryPoints: ['scripts/replay-page.mjs'], outfile: resolve(staging, 'replay-page.mjs'), format: 'esm' });
}
if (process.argv.includes('--stress')) {
  await cp(resolve(root, 'scripts/stress.html'), resolve(staging, 'stress.html'));
  await build({ ...cfg, entryPoints: ['scripts/stress-page.mjs'], outfile: resolve(staging, 'stress-page.mjs'), format: 'esm' });
}
async function collect(folder, prefix = '') {
  const items = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) items.push(...await collect(resolve(folder, entry.name), relative + '/'));
    else if (!['sw.js', 'runtime.json', 'replay.html', 'replay-page.mjs', 'stress.html', 'stress-page.mjs'].includes(relative)) {
      const bytes = await readFile(resolve(folder, entry.name));
      items.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  return items;
}
const assets = await collect(staging);
const version = digest(JSON.stringify(assets)).slice(0, 16);
const manifest = { version, assets };
const sw = await readFile(resolve(root, 'src/sw.js'), 'utf8');
await writeFile(resolve(staging, 'sw.js'), 'const RELEASE = ' + JSON.stringify(manifest) + ';\n' + sw);
await writeFile(resolve(staging, 'runtime.json'), JSON.stringify(manifest, null, 2));
// Everything succeeded: replace the served directory in one step so a visitor never sees a half-built
// kiosk (a dist without main.mjs renders as a styled but dead page).
await rm(out, { recursive: true, force: true });
await cp(staging, out, { recursive: true });
await rm(staging, { recursive: true, force: true });
console.log('GameShow ' + version + ' · ' + assets.length + ' offline assets · ' +
  (assets.reduce((sum, asset) => sum + asset.bytes, 0) / 1e6).toFixed(1) + ' MB');

