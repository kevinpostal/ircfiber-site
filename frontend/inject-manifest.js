#!/usr/bin/env node
/**
 * Post-build script: reads Vite's manifest.json and injects the
 * content-hashed CSS/JS URLs into views/index.dt.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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

// Helper to find manifest entry by file substring
function findByFile(substr) {
  return Object.values(manifest).find(v => v.file && v.file.includes(substr));
}

const mainCss = (entry.css && entry.css[0]) ? `/public/dist/${entry.css[0]}` : null;
const mainJs = `/public/dist/${entry.file}`;

const vendor = findByFile('vendor');
const vendorJs = vendor ? `/public/dist/${vendor.file}` : null;
const vendorCss = vendor && vendor.css && vendor.css[0] ? `/public/dist/${vendor.css[0]}` : null;

const chunkUpload = findByFile('chunk-upload');
const chunkUploadJs = chunkUpload ? `/public/dist/${chunkUpload.file}` : null;
const chunkUploadCss = chunkUpload && chunkUpload.css && chunkUpload.css[0] ? `/public/dist/${chunkUpload.css[0]}` : null;

const chunkEditor = findByFile('chunk-editor');
const chunkEditorJs = chunkEditor ? `/public/dist/${chunkEditor.file}` : null;
const chunkEditorCss = chunkEditor && chunkEditor.css && chunkEditor.css[0] ? `/public/dist/${chunkEditor.css[0]}` : null;

// Build the new block scripts section
let lines = [];
lines.push('block scripts');
lines.push('  // Preload the critical CSS/JS so the browser can start fetching before parsing');
if (mainCss) {
  lines.push(`  link(rel="preload", href="${mainCss}", as="style")`);
  lines.push(`  link(rel="stylesheet", href="${mainCss}")`);
}
if (chunkUploadCss) {
  lines.push(`  link(rel="preload", href="${chunkUploadCss}", as="style")`);
  lines.push(`  link(rel="stylesheet", href="${chunkUploadCss}")`);
}
if (chunkEditorCss) {
  lines.push(`  link(rel="preload", href="${chunkEditorCss}", as="style")`);
  lines.push(`  link(rel="stylesheet", href="${chunkEditorCss}")`);
}
if (vendorCss && vendorCss !== mainCss) {
  // vendor CSS is already often included via main, but ensure
}
if (vendorJs) lines.push(`  link(rel="modulepreload", href="${vendorJs}")`);
if (chunkUploadJs) lines.push(`  link(rel="modulepreload", href="${chunkUploadJs}")`);
if (chunkEditorJs) lines.push(`  link(rel="modulepreload", href="${chunkEditorJs}")`);
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
if (chunkUploadCss) console.log(`inject-manifest: chunk-upload CSS → ${chunkUploadCss}`);
if (chunkEditorCss) console.log(`inject-manifest: chunk-editor CSS → ${chunkEditorCss}`);
console.log(`inject-manifest: JS  → ${mainJs}`);
if (vendorJs) console.log(`inject-manifest: vendor → ${vendorJs}`);
if (chunkUploadJs) console.log(`inject-manifest: chunk-upload → ${chunkUploadJs}`);
if (chunkEditorJs) console.log(`inject-manifest: chunk-editor → ${chunkEditorJs}`);

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
