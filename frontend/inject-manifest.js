#!/usr/bin/env node
/**
 * Post-build script: reads Vite's manifest.json and injects the
 * content-hashed CSS/JS URLs into views/index.dt.
 *
 * This replaces the old manual `?v=N` cache-buster approach so that
 * every frontend rebuild produces unique URLs that naturally
 * invalidate the browser cache.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const manifestPath = resolve(projectRoot, 'public/dist/.vite/manifest.json');
// Split-layout gateway: the gateway image builds /app/views from backend/views.
const dtPath = resolve(projectRoot, 'backend/views/index.dt');

// Read manifest
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

const jsFile = entry.file;
const cssFiles = entry.css || [];

// Read current index.dt
let dt = readFileSync(dtPath, 'utf-8');

// Replace CSS link + preloads
const cssPattern = /link\(rel="stylesheet",\s*href="\/public\/dist\/[^"]*"\)/;
const preloadCssPattern = /link\(rel="preload",\s*href="\/public\/dist\/[^"]*",\s*as="style"\)/;
// Actually, use the actual CSS files from the manifest entry
// For the first CSS file
if (cssFiles.length > 0) {
  const newCssHref = `/public/dist/${cssFiles[0]}`;
  dt = dt.replace(cssPattern, `link(rel="stylesheet", href="${newCssHref}")`);
  dt = dt.replace(preloadCssPattern, `link(rel="preload", href="${newCssHref}", as="style")`);
  console.log(`inject-manifest: CSS → ${newCssHref}`);
} else {
  // Fallback: guess the CSS path from the JS path
  const guessedCss = jsFile.replace(/\.js$/, '.css');
  const newCssHref = `/public/dist/${guessedCss}`;
  dt = dt.replace(cssPattern, `link(rel="stylesheet", href="${newCssHref}")`);
  dt = dt.replace(preloadCssPattern, `link(rel="preload", href="${newCssHref}", as="style")`);
  console.log(`inject-manifest: CSS → ${newCssHref} (guessed, no css entry in manifest)`);
}

// Replace JS script - remove ?v=2: hashes are content-addressed, immutable cache handles it
const jsPattern = /script\(type="module",\s*src="\/public\/dist\/[^"]*"\)/;
const newJsHref = `/public/dist/${jsFile}`;
dt = dt.replace(jsPattern, `script(type="module", src="${newJsHref}")`);
console.log(`inject-manifest: JS  → ${newJsHref}`);

// Also ensure vendor-svelte modulepreload is present (critical chunk)
try {
  const vendorEntry = Object.values(manifest).find(v => v.file && v.file.includes('vendor-svelte'));
  if (vendorEntry) {
    const vendorHref = `/public/dist/${vendorEntry.file}`;
    if (!dt.includes(vendorHref)) {
      // Insert after CSS preload
      dt = dt.replace(
        `link(rel="preload", href="/public/dist/${cssFiles[0] || ''}", as="style")`,
        `link(rel="preload", href="/public/dist/${cssFiles[0] || ''}", as="style")\n  link(rel="modulepreload", href="${vendorHref}")`
      );
      console.log(`inject-manifest: vendor preload → ${vendorHref}`);
    }
  }
} catch {}

// Also emit .gz and .br for precompressed serving (backend serves them if Accept-Encoding matches)
try {
  const assetsDir = resolve(projectRoot, 'public/dist/assets');
  for (const f of readdirSync(assetsDir)) {
    if (f.endsWith('.gz') || f.endsWith('.br')) continue;
    const full = resolve(assetsDir, f);
    if (!existsSync(full)) continue;
    const data = readFileSync(full);
    // Only compress text assets
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

// Write updated index.dt
writeFileSync(dtPath, dt, 'utf-8');
console.log('inject-manifest: views/index.dt updated');
