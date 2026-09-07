/**
 * Highlight-language registry — keeps highlight.js grammars out of first paint.
 *
 * Only the 8 most common grammars are bundled eagerly (core). The remaining
 * ~30 load on demand via dynamic import() the first time a code block needs
 * them, then stay cached in-memory and in the HTTP cache.
 *
 * Callers: TextInline (chat code blocks), FileViewerPage, HtmlPreviewTabs.
 * Edit-mode paths only need the language NAME (CodeEditor takes a string),
 * so `languageNameForFile` / `languageNameForMode` are fully synchronous.
 * View paths need the grammar OBJECT for <Highlight> — resolve it with
 * `ensureLanguage`, falling back to plaintext while loading.
 */
import plaintext from 'svelte-highlight/languages/plaintext';
import javascript from 'svelte-highlight/languages/javascript';
import typescript from 'svelte-highlight/languages/typescript';
import python from 'svelte-highlight/languages/python';
import bash from 'svelte-highlight/languages/bash';
import json from 'svelte-highlight/languages/json';
import yaml from 'svelte-highlight/languages/yaml';
import markdown from 'svelte-highlight/languages/markdown';

// svelte-highlight language objects are untyped granular grammars; the
// components already treat them as `any`, so keep that convention here.
export type HlLang = any;

const CORE: Record<string, HlLang> = {
  plaintext, text: plaintext,
  javascript, js: javascript, jsx: javascript, mjs: javascript, cjs: javascript,
  typescript, ts: typescript, tsx: typescript, mts: typescript, cts: typescript,
  python, py: python,
  bash, sh: bash, zsh: bash,
  json, yaml, yml: yaml,
  markdown, md: markdown,
};

export function coreLanguage(name: string): HlLang | null {
  if (!name) return null;
  return CORE[name.toLowerCase()] ?? null;
}

const EXT_TO_NAME: Record<string, string> = {
  txt: 'plaintext', text: 'plaintext', log: 'plaintext',
  md: 'markdown', markdown: 'markdown',
  json: 'json',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', python: 'python',
  java: 'java',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', csharp: 'csharp',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  php: 'php',
  rb: 'ruby', ruby: 'ruby',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', html: 'xml', htm: 'xml', xhtml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', toml: 'toml', ini: 'ini',
  lua: 'lua', perl: 'perl', powershell: 'powershell',
  r: 'r', graphql: 'graphql', graphqlschema: 'graphql', protobuf: 'protobuf',
  json5: 'json', kt: 'kotlin',
  twig: 'twig', verilog: 'verilog', vhdl: 'vhdl', zig: 'zig',
  swift: 'swift', kotlin: 'kotlin', dart: 'dart',
  dockerfile: 'dockerfile', makefile: 'makefile', nginx: 'nginx',
};

/** Canonical grammar name for a filename/URL. Synchronous, pure. */
export function languageNameForFile(filename: string): string {
  const lower = (filename || '').toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  if (BASENAME_TO_NAME[base]) return BASENAME_TO_NAME[base];
  const ext = base.split('.').pop() ?? '';
  if (EXT_TO_NAME[ext]) return EXT_TO_NAME[ext];
  // Full grammar names are valid too (pastebin syntax ids like `python`).
  if (ext === 'plaintext' || CORE[ext] || loaders[ext]) return ext;
  return 'plaintext';
}

/** Canonical grammar name for a detectSyntaxFromFilename mode string. */
export function languageNameForMode(mode: string): string {
  const m = (mode || 'text').toLowerCase();
  if (m === 'text') return 'plaintext';
  if (m === 'c_cpp') return 'cpp';
  if (EXT_TO_NAME[m]) return EXT_TO_NAME[m];
  if (m === 'plaintext' || CORE[m] || loaders[m]) return m;
  return 'plaintext';
}

const loaders: Record<string, () => Promise<any>> = {
  java: () => import('svelte-highlight/languages/java'),
  cpp: () => import('svelte-highlight/languages/cpp'),
  csharp: () => import('svelte-highlight/languages/csharp'),
  go: () => import('svelte-highlight/languages/go'),
  rust: () => import('svelte-highlight/languages/rust'),
  php: () => import('svelte-highlight/languages/php'),
  ruby: () => import('svelte-highlight/languages/ruby'),
  xml: () => import('svelte-highlight/languages/xml'),
  css: () => import('svelte-highlight/languages/css'),
  scss: () => import('svelte-highlight/languages/scss'),
  less: () => import('svelte-highlight/languages/less'),
  sql: () => import('svelte-highlight/languages/sql'),
  toml: () => import('svelte-highlight/languages/toml'),
  ini: () => import('svelte-highlight/languages/ini'),
  lua: () => import('svelte-highlight/languages/lua'),
  perl: () => import('svelte-highlight/languages/perl'),
  powershell: () => import('svelte-highlight/languages/powershell'),
  r: () => import('svelte-highlight/languages/r'),
  graphql: () => import('svelte-highlight/languages/graphql'),
  protobuf: () => import('svelte-highlight/languages/protobuf'),
  twig: () => import('svelte-highlight/languages/twig'),
  verilog: () => import('svelte-highlight/languages/verilog'),
  vhdl: () => import('svelte-highlight/languages/vhdl'),
  zig: () => import('svelte-highlight/languages/zig'),
  swift: () => import('svelte-highlight/languages/swift'),
  kotlin: () => import('svelte-highlight/languages/kotlin'),
  dart: () => import('svelte-highlight/languages/dart'),
  dockerfile: () => import('svelte-highlight/languages/dockerfile'),
  makefile: () => import('svelte-highlight/languages/makefile'),
  nginx: () => import('svelte-highlight/languages/nginx'),
};

const cache = new Map<string, HlLang>();

/** Grammar object for <Highlight>. Core names resolve sync; the rest fetch once. */
export async function ensureLanguage(name: string): Promise<HlLang> {
  const n = (name || 'plaintext').toLowerCase();
  const core = coreLanguage(n);
  if (core) return core;
  const hit = cache.get(n);
  if (hit) return hit;
  const loader = loaders[n];
  if (!loader) return plaintext;
  try {
    const mod = await loader();
    const lang = mod.default ?? mod[n] ?? plaintext;
    cache.set(n, lang);
    return lang;
  } catch {
    return plaintext;
  }
}
