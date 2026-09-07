#!/usr/bin/env node
/**
 * Post-build script: reads Vite's manifest.json and injects the
 * content-hashed CSS/JS URLs into views/index.dt.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const manifestPath = resolve(projectRoot, 'public/dist/.vite/manifest.json');
const dtPath = resolve(projectRoot, 'backend/views/index.dt');

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
} catch (e) {
  console.error('inject-manifest: could not read manifest at', manifestPath);
  process.exit(1);
}

const entry = manifest['index.html'];
if (!entry) {
  console.error('inject-manifest: no index.html entry in manifest');
  process.exit(1);
}

let dt = readFileSync(dtPath, 'utf-8');

// Helper to find manifest entry by file substring — must be the JS chunk, not the CSS asset
function findJsByFile(substr) {
  return Object.values(manifest).find(v => v.file && v.file.includes(substr) && v.file.endsWith('.js'));
}

const mainCss = (entry.css && entry.css[0]) ? `/public/dist/${entry.css[0]}` : null;
const mainJs = `/public/dist/${entry.file}`;

// NOTE: match the chat vendor exactly — 'vendor-admin' (admin SPA only) also
// contains the substring 'vendor' and must never be preloaded by the chat shell.
const vendor = Object.values(manifest).find(v => v.file && v.file.endsWith('.js') && v.file.includes('vendor') && !v.file.includes('vendor-admin'));
const vendorJs = vendor ? `/public/dist/${vendor.file}` : null;
const vendorCss = vendor && vendor.css && vendor.css[0] ? `/public/dist/${vendor.css[0]}` : null;

// Eager CSS = the entry + its STATIC import closure. Feature chunks
// (chunk-upload/pages/panels/editor) are dynamic import()s since the SPA
// lazy-load split — Vite injects their stylesheets at runtime when the chunk
// loads, so linking them here would force-download them on first paint.
const staticCss = [];
(function collect(key, seen = new Set()) {
  if (seen.has(key)) return;
  seen.add(key);
  const node = manifest[key];
  if (!node) return;
  for (const c of node.css || []) staticCss.push(`/public/dist/${c}`);
  for (const imp of node.imports || []) collect(imp, seen);
})('index.html');

// Build the new block scripts section
let lines = [];
lines.push('block scripts');
lines.push('  // Preload only the critical CSS/JS (entry + vendor); feature chunks load on demand');
const injectedCss = new Set();
function addCss(href) {
  if (!href || injectedCss.has(href)) return;
  injectedCss.add(href);
  lines.push(`  link(rel="preload", href="${href}", as="style")`);
  lines.push(`  link(rel="stylesheet", href="${href}")`);
}
addCss(mainCss);
for (const href of staticCss) addCss(href);
console.log('inject-manifest: stylesheet links →', [...injectedCss].join(', '));
if (vendorJs) lines.push(`  link(rel="modulepreload", href="${vendorJs}")`);
lines.push(`  script(type="module", src="${mainJs}")`);

const newBlock = lines.join('\n');

// Replace the entire block scripts section (from "block scripts" to next "block" or EOF)
const blockRegex = /block scripts[\s\S]*?(?=\nblock |\n*$)/;
if (blockRegex.test(dt)) {
  dt = dt.replace(blockRegex, newBlock + '\n');
  console.log('inject-manifest: regenerated block scripts');
} else {
  // Fallback to old regex method
  if (mainCss) {
    const cssPattern = /link\(rel="stylesheet",\s*href="\/public\/dist\/[^"]*"\)/;
    const preloadCssPattern = /link\(rel="preload",\s*href="\/public\/dist\/[^"]*",\s*as="style"\)/;
    dt = dt.replace(cssPattern, `link(rel="stylesheet", href="${mainCss}")`);
    dt = dt.replace(preloadCssPattern, `link(rel="preload", href="${mainCss}", as="style")`);
  }
  const jsPattern = /script\(type="module",\s*src="\/public\/dist\/[^"]*"\)/;
  dt = dt.replace(jsPattern, `script(type="module", src="${mainJs}")`);
}

console.log(`inject-manifest: CSS → ${mainCss}`);
console.log(`inject-manifest: JS  → ${mainJs}`);
if (vendorJs) console.log(`inject-manifest: vendor → ${vendorJs}`);

// Prune stale content-hashed bundles: every build emits new hashes, and
// without pruning dist/assets accumulates all previous generations (1.2MB
// vendor × N deploys). Keep exactly what this build's manifest references
// (both entries + full import closures); delete anything else. The 1h
// browser-cached shell window after a deploy is covered by the deploy's
// old-hash alias step, not by shipping old bundles in the image.
try {
  const keep = new Set();
  const seen = new Set();
  function mark(key) {
    if (seen.has(key)) return;
    seen.add(key);
    const node = manifest[key];
    if (!node) return;
    if (node.file) keep.add(node.file);
    for (const c of node.css || []) keep.add(c);
    for (const a of node.assets || []) keep.add(a);
    for (const imp of node.imports || []) mark(imp);
    for (const imp of node.dynamicImports || []) mark(imp);
  }
  mark('index.html');
  mark('admin.html');
  const assetsDir = resolve(projectRoot, 'public/dist/assets');
  let pruned = 0;
  for (const f of readdirSync(assetsDir)) {
    const base = f.replace(/\.(gz|br|map)$/, '');
    if (!/\.(js|css)$/.test(base)) continue;
    if (keep.has(`assets/${base}`)) continue;
    try { unlinkSync(resolve(assetsDir, f)); pruned++; }
    catch {}
  }
  console.log(`inject-manifest: pruned ${pruned} stale asset file(s)`);
} catch (e) {
  console.warn('inject-manifest: prune skipped', e.message);
}

// Also emit .gz and .br for precompressed serving
try {
  const assetsDir = resolve(projectRoot, 'public/dist/assets');
  for (const f of readdirSync(assetsDir)) {
    if (f.endsWith('.gz') || f.endsWith('.br')) continue;
    const full = resolve(assetsDir, f);
    if (!existsSync(full)) continue;
    const data = readFileSync(full);
    if (!/\.(js|css|svg|html|json|wasm)$/.test(f)) continue;
    const gzPath = full + '.gz';
    const brPath = full + '.br';
    try { writeFileSync(gzPath, gzipSync(data, { level: 9 })); } catch {}
    try { writeFileSync(brPath, brotliCompressSync(data)); } catch {}
  }
  console.log('inject-manifest: precompressed .gz/.br emitted');
} catch (e) {
  console.warn('inject-manifest: precompress skipped', e.message);
}

writeFileSync(dtPath, dt, 'utf-8');
console.log('inject-manifest: views/index.dt updated');
