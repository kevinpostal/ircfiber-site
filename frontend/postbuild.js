#!/usr/bin/env node
/**
 * Post-build script: prunes stale content-hashed bundles from public/dist
 * and emits .gz/.br siblings for precompressed serving.
 *
 * The SPA shell (backend/views/index.dt) is NOT touched here: the gateway
 * reads public/dist/.vite/manifest.json at runtime (ircfiber.web.assets),
 * so the committed template is build-independent.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const manifestPath = resolve(projectRoot, 'public/dist/.vite/manifest.json');

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
} catch (e) {
  console.error('postbuild: could not read manifest at', manifestPath);
  process.exit(1);
}

if (!manifest['index.html']) {
  console.error('postbuild: no index.html entry in manifest');
  process.exit(1);
}

// Prune stale content-hashed bundles: every build emits new hashes, and
// without pruning dist/assets accumulates all previous generations (1.2MB
// vendor × N deploys). Keep exactly what this build's manifest references
// (both entries + full import closures); delete anything else.
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
    if (!/\.(js|css|bin)$/.test(base)) continue;
    if (keep.has(`assets/${base}`)) continue;
    try { unlinkSync(resolve(assetsDir, f)); pruned++; }
    catch {}
  }
  console.log(`postbuild: pruned ${pruned} stale asset file(s)`);
} catch (e) {
  console.warn('postbuild: prune skipped', e.message);
}

// Also emit .gz and .br for precompressed serving
try {
  const assetsDir = resolve(projectRoot, 'public/dist/assets');
  for (const f of readdirSync(assetsDir)) {
    if (f.endsWith('.gz') || f.endsWith('.br')) continue;
    const full = resolve(assetsDir, f);
    if (!existsSync(full)) continue;
    const data = readFileSync(full);
    if (!/\.(js|css|svg|html|json|wasm|bin)$/.test(f)) continue;
    const gzPath = full + '.gz';
    const brPath = full + '.br';
    try { writeFileSync(gzPath, gzipSync(data, { level: 9 })); } catch {}
    try { writeFileSync(brPath, brotliCompressSync(data)); } catch {}
  }
  console.log('postbuild: precompressed .gz/.br emitted');
} catch (e) {
  console.warn('postbuild: precompress skipped', e.message);
}
