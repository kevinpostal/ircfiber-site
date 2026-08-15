#!/usr/bin/env node
/**
 * Post-build script: reads Vite's manifest.json and injects the
 * content-hashed CSS/JS URLs into views/index.dt.
 *
 * This replaces the old manual `?v=N` cache-buster approach so that
 * every frontend rebuild produces unique URLs that naturally
 * invalidate the browser cache.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Replace CSS link
const cssPattern = /link\(rel="stylesheet",\s*href="\/public\/dist\/[^"]*"\)/;
const cssReplacement = `link(rel="stylesheet", href="/public/dist/${jsFile.replace(/\.js$/, '.css')}")`;
// Actually, use the actual CSS files from the manifest entry
// For the first CSS file
if (cssFiles.length > 0) {
  const newCssHref = `/public/dist/${cssFiles[0]}?v=2`;
  dt = dt.replace(cssPattern, `link(rel="stylesheet", href="${newCssHref}")`);
  console.log(`inject-manifest: CSS → ${newCssHref}`);
} else {
  // Fallback: guess the CSS path from the JS path
  const guessedCss = jsFile.replace(/\.js$/, '.css');
  const newCssHref = `/public/dist/${guessedCss}?v=2`;
  dt = dt.replace(cssPattern, `link(rel="stylesheet", href="${newCssHref}")`);
  console.log(`inject-manifest: CSS → ${newCssHref} (guessed, no css entry in manifest)`);
}

// Replace JS script
const jsPattern = /script\(type="module",\s*src="\/public\/dist\/[^"]*"\)/;
const newJsHref = `/public/dist/${jsFile}?v=2`;
dt = dt.replace(jsPattern, `script(type="module", src="${newJsHref}")`);
console.log(`inject-manifest: JS  → ${newJsHref}`);

// Write updated index.dt
writeFileSync(dtPath, dt, 'utf-8');
console.log('inject-manifest: views/index.dt updated');
