<script lang="ts">
  import Highlight, { LineNumbers } from 'svelte-highlight';
  import 'svelte-highlight/styles/atom-one-dark.css';
  import plaintext from 'svelte-highlight/languages/plaintext';
  import python from 'svelte-highlight/languages/python';
  import javascript from 'svelte-highlight/languages/javascript';
  import typescript from 'svelte-highlight/languages/typescript';
  import bash from 'svelte-highlight/languages/bash';
  import json from 'svelte-highlight/languages/json';
  import yaml from 'svelte-highlight/languages/yaml';
  import markdown from 'svelte-highlight/languages/markdown';
  import sql from 'svelte-highlight/languages/sql';
  import xml from 'svelte-highlight/languages/xml';
  import css from 'svelte-highlight/languages/css';
  import scss from 'svelte-highlight/languages/scss';
  import less from 'svelte-highlight/languages/less';
  import java from 'svelte-highlight/languages/java';
  import cpp from 'svelte-highlight/languages/cpp';
  import csharp from 'svelte-highlight/languages/csharp';
  import go from 'svelte-highlight/languages/go';
  import rust from 'svelte-highlight/languages/rust';
  import ruby from 'svelte-highlight/languages/ruby';
  import php from 'svelte-highlight/languages/php';
  import swift from 'svelte-highlight/languages/swift';
  import kotlin from 'svelte-highlight/languages/kotlin';
  import dart from 'svelte-highlight/languages/dart';
  import ini from 'svelte-highlight/languages/ini';
  import dockerfile from 'svelte-highlight/languages/dockerfile';
  import makefile from 'svelte-highlight/languages/makefile';
  import nginx from 'svelte-highlight/languages/nginx';
  import lua from 'svelte-highlight/languages/lua';
  import perl from 'svelte-highlight/languages/perl';
  import powershell from 'svelte-highlight/languages/powershell';
  import rlang from 'svelte-highlight/languages/r';
  import graphql from 'svelte-highlight/languages/graphql';
  import protobuf from 'svelte-highlight/languages/protobuf';
  import twig from 'svelte-highlight/languages/twig';
  import verilog from 'svelte-highlight/languages/verilog';
  import vhdl from 'svelte-highlight/languages/vhdl';
  import zig from 'svelte-highlight/languages/zig';
  import toml from 'svelte-highlight/languages/toml';

  interface Props {
    url: string;
  }
  let { url }: Props = $props();
  // For /uploads URLs, use pathname for fetch + href so vite proxy avoids https loopback cert issue
  let displayUrl = $derived((()=>{ try{ const u=new URL(url, location.origin); if(u.pathname.startsWith('/uploads/')) return u.pathname+u.search+u.hash; }catch{} return url; })());

  let code = $state<string | null>(null);
  let errored = $state(false);
  let closed = $state(false);

  // Map URL extension to svelte-highlight language
  function detectLang(u: string): any {
    const pathname = (() => { try { return new URL(u).pathname.toLowerCase(); } catch { return u.toLowerCase(); } })();
    const ext = pathname.split('.').pop() ?? '';
    const base = pathname.split('/').pop() ?? '';
    if (base === 'dockerfile') return dockerfile;
    if (base === 'makefile') return makefile;
    const map: Record<string, any> = {
      txt: plaintext, text: plaintext, log: plaintext,
      md: markdown, markdown,
      json, js: javascript, jsx: javascript, mjs: javascript, cjs: javascript,
      ts: typescript, tsx: typescript, mts: typescript, cts: typescript,
      py: python,
      java,
      c: cpp, h: cpp, cc: cpp, cpp, cxx: cpp, hpp: cpp,
      cs: csharp, go, rs: rust, php, rb: ruby, sh: bash, bash, zsh: bash,
      yaml, yml: yaml,
      xml, html: xml, htm: xml,
      css, scss, less,
      sql, toml, ini,
      lua, perl, powershell, r: rlang, graphql, protobuf, twig, verilog, vhdl, zig,
      swift, kotlin, dart,
      dockerfile, makefile, nginx,
    };
    return map[ext] ?? plaintext;
  }

  async function load() {
    try {
      // For our own /uploads URLs, fetch via pathname so vite's /uploads proxy
      // handles http->backend and we avoid https://127.0.0.1:8090 mixed-protocol/CORS failures.
      // Backend may store https://127.0.0.1:8090/uploads/... (loopback forced to https by textInline.ts before fix);
      // fetching that directly fails (no cert on 8090). Use pathname+search instead.
      let fetchUrl = url;
      try {
        const u = new URL(url, location.origin);
        if (u.pathname.startsWith('/uploads/')) fetchUrl = u.pathname + u.search + u.hash;
      } catch {}
      const res = await fetch(fetchUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // Truncate very large files for inline preview (first 50KB)
      const truncated = text.length > 50000 ? text.slice(0, 50000) + '\n\n… truncated …' : text;
      code = truncated;
      hlLang = detectLang(url);
    } catch (e) {
      console.warn('TextInline failed to load', url, e);
      errored = true;
    }
  }

  let hlLang: any = $state(plaintext);
  $effect(() => {
    hlLang = detectLang(url);
    void load();
  });

  function onClose(e: MouseEvent) {
    e.preventDefault();
    closed = true;
  }
</script>

{#if !closed && !errored && code !== null}
  <span class="directEmbedWrap textWrap" data-text-url={url}>
    <div class="textInlineHeader">
      <a href={displayUrl} target="_blank" rel="noreferrer" class="textLink">{url.split('/').pop()}</a>
      <span class="textLang">{hlLang?.name ?? 'text'}</span>
      <a href={displayUrl} target="_blank" rel="noreferrer" class="textOpen">open</a>
    </div>
    <div class="textInlineBody">
      <Highlight language={hlLang} code={code} let:highlighted>
        <LineNumbers
          {highlighted}
          startingLineNumber={1}
          --line-number-color="rgba(255, 255, 255, 0.35)"
          --border-color="rgba(255, 255, 255, 0.08)"
        />
      </Highlight>
    </div>
  </span>
{/if}

<style>
  .textWrap {
    display: block;
    margin: 6px 0;
    border: 1px solid #2c2f35;
    border-radius: 6px;
    overflow: hidden;
    background: #0d1117;
    max-width: 100%;
  }
  .textInlineHeader {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: #161b22;
    border-bottom: 1px solid #21262d;
    font-size: 12px;
    color: #8b949e;
  }
  .textLink {
    color: #58a6ff;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .textLink:hover { text-decoration: underline; }
  .textLang {
    background: #21262d;
    color: #8b949e;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    text-transform: uppercase;
  }
  .textOpen {
    color: #8b949e;
    text-decoration: none;
    font-size: 11px;
  }
  .textOpen:hover { color: #e6edf3; }
  .embedClose {
    background: none;
    border: none;
    color: #8b949e;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 4px;
  }
  .embedClose:hover { color: #f85149; }
  .textInlineBody {
    max-height: min(480px, 60vh);
    overflow: auto;
    background: #282c34;
  }
  /* svelte-highlight LineNumbers structure: div > table > tbody > tr > td */
  .textInlineBody :global(div) {
    background: transparent;
  }
  .textInlineBody :global(table),
  .textInlineBody :global(tr),
  .textInlineBody :global(td) {
    background: transparent;
    padding: 0;
    vertical-align: baseline;
  }
  .textInlineBody :global(pre) {
    margin: 0;
    background: transparent;
    font-family: 'Hack', 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.35;
  }
  .textInlineBody :global(pre code) {
    display: block;
    padding: 0 12px 0 0;
    background: transparent;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    white-space: pre;
    word-wrap: normal;
  }
  .textInlineBody :global(td > code) {
    font-family: 'Hack', 'SF Mono', Menlo, monospace;
    font-size: 12px;
    line-height: 1.35;
  }
</style>
