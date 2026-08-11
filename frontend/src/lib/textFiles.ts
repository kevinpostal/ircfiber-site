/** Text-file detection + syntax auto-detect, mirroring IRCCloud's `s.isText` + ace modelist mapping.
 *  IRCCloud: `isText` = /^text\//i or known xml/json/js mime types; fallback to extension check.
 *  See captured `/tmp/irccloud-capture/common.js` o1Zz doUpload: `s.isText(l.type)` gate
 *  and ace/ext/modelist `getModeForPath` for filename -> mode.
 */

export const MAX_TEXT_FILE_BYTES = 15_728_640; // 15 MB, matches IRCCloud n.MAX_LENGTH_BYTES
export const MAX_PASTE_BYTES = 50_000; // paste limit from common.js paste model

const TEXT_MIMES = new Set([
  'application/atom+xml',
  'application/ecmascript',
  'application/javascript',
  'application/json',
  'application/rdf+xml',
  'application/rss+xml',
  'application/xhtml+xml',
  'application/xml',
]);

export function isTextMime(mime: string): boolean {
  if (!mime) return false;
  if (/^text\//i.test(mime)) return true;
  if (TEXT_MIMES.has(mime.toLowerCase())) return true;
  return false;
}

// Extension -> ace mode id (subset of ACE_MODES; covers IRCCloud parity for common files)
// IRCCloud via `ace/ext/modelist` maps extension regex -> mode. We mirror the common ones;
// unknown extensions fall back to 'text' (Plain Text).
const EXT_TO_MODE: Record<string, string> = {
  // no extension / dotfiles
  txt: 'text', log: 'text', text: 'text',
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', gemspec: 'ruby', rake: 'ruby',
  java: 'java',
  c: 'c_cpp', h: 'c_cpp', cpp: 'c_cpp', cxx: 'c_cpp', cc: 'c_cpp', hpp: 'c_cpp', hh: 'c_cpp',
  cs: 'csharp',
  go: 'golang',
  rs: 'rust',
  php: 'php', phtml: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh', fish: 'sh',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', stylus: 'stylus',
  json: 'json', json5: 'json5',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', svg: 'svg',
  toml: 'toml',
  sql: 'sql', pgsql: 'pgsql', mysql: 'mysql',
  graphql: 'graphqlschema', gql: 'graphqlschema', graphqls: 'graphqlschema',
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'makefile', mk: 'makefile',
  ini: 'ini', conf: 'ini', cfg: 'ini', properties: 'properties',
  lua: 'lua',
  perl: 'perl', pl: 'perl', pm: 'perl',
  swift: 'swift',
  kotlin: 'kotlin', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', sc: 'scala',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
  ex: 'elixir', exs: 'elixir', eex: 'html_elixir',
  dart: 'dart',
  r: 'r', rmd: 'r',
  jl: 'julia',
  hs: 'haskell', lhs: 'haskell',
  erl: 'erlang', hrl: 'erlang',
  elm: 'elm',
  vue: 'vue', svelte: 'svelte',
  astro: 'astro',
  tf: 'terraform', hcl: 'terraform',
  nix: 'nix',
  nginx: 'nginx',
  apache: 'apache_conf', htaccess: 'apache_conf',
  bat: 'batchfile', cmd: 'batchfile',
  ps1: 'powershell', psm1: 'powershell',
  tex: 'tex', latex: 'latex',
  diff: 'diff', patch: 'diff',
  csv: 'csv',
  prql: 'prql',
  proto: 'protobuf',
  zig: 'zig',
  nim: 'nim',
  coffee: 'coffee',
  pug: 'jade', jade: 'jade',
  handlebars: 'handlebars', hbs: 'handlebars',
  liquid: 'liquid',
};

const BASENAME_TO_MODE: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
};

/** Detect Ace mode id from filename. Returns 'text' when unknown. */
export function detectSyntaxFromFilename(filename: string): string {
  const base = filename.trim().toLowerCase();
  if (!base) return 'text';
  // bare basename like "Dockerfile", "Makefile"
  const withoutPath = base.split('/').pop()!.split('\\').pop()!;
  if (BASENAME_TO_MODE[withoutPath]) return BASENAME_TO_MODE[withoutPath];
  // extension
  const dotIdx = withoutPath.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === withoutPath.length - 1) return 'text';
  const ext = withoutPath.slice(dotIdx + 1).toLowerCase();
  return EXT_TO_MODE[ext] ?? 'text';
}

/** IRCCloud parity: is this file a text file that should open the snippet dialog?
 *  Matches `s.isText(l.type)` plus fallback to extension (for files where
 *  browser reports empty or generic mime like `application/octet-stream`).
 */
export function isTextFile(file: { name: string; type: string }): boolean {
  if (isTextMime(file.type)) return true;
  // Fallback: known texty extensions are treated as text even if mime is empty/generic.
  // This covers OS cases where .txt is reported as "" or application/octet-stream,
  // and binary-ish extensions like .log, .md, .csv etc.
  const mode = detectSyntaxFromFilename(file.name);
  if (mode !== 'text') return true;
  // Also treat .txt/.log/.text etc that map to 'text' but still are plain text files
  const lower = file.name.toLowerCase();
  const texty = /\.(txt|text|log|csv|md|markdown|ini|cfg|conf|properties|toml|yaml|yml|json|xml|html|css|js|ts|py|rb|java|c|cpp|h|hpp|go|rs|php|sh|pl|swift|kt|scala|dart|r|jl|hs|erl|elm|vue|svelte|astro|tf|nix|sql|graphql|gql|proto|zig|nim|coffee|jade|pug|twig|hbs|liquid|tex|diff|patch)$/i;
  if (texty.test(lower)) return true;
  // MIME empty but filename looks textual? Check if extension is known at all.
  // If type is empty we conservatively treat as text to avoid "Only images" dead-end for .txt.
  if (!file.type && /\.[a-z0-9]{1,8}$/i.test(lower)) {
    // unknown mime + has extension -> let it be text (paste dialog), except known binaries
    const binaryExt = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|mp4|mov|avi|mkv|webm|mp3|wav|ogg|flac|zip|tar|gz|bz2|xz|7z|rar|pdf|doc|docx|xls|xlsx|ppt|pptx|exe|dll|so|dylib|bin)$/i;
    if (!binaryExt.test(lower)) return true;
  }
  return false;
}

export async function readFileAsText(file: File): Promise<string> {
  return file.text();
}
