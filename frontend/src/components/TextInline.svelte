<script lang="ts">
  import { tick, onMount } from 'svelte';
  import Highlight from 'svelte-highlight';
  import 'svelte-highlight/styles/atom-one-dark.css';
  import CodeEditor from './CodeEditor.svelte';
  import { fetchUploadsOffset, editUpload, fetchMe } from '../stores/api';
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
  let displayUrl = $derived((()=>{ try{ const u=new URL(url, location.origin); if(u.pathname.startsWith('/uploads/')) return u.pathname+u.search+u.hash; }catch{} return url; })());

  let code = $state<string | null>(null);
  let errored = $state(false);
  let closed = $state(false);
  let gutterHidden = $state(false);
  let editing = $state(false);
  let editValue = $state('');
  let editFilename = $state('');
  let localName = $state<string | null>(null);
  let editError = $state<string | null>(null);
  let uploadName = $state<string | null>(null);
  let uploadIdForEdit = $state<string | null>(null);
  let editSaving = $state(false);
  let meId: string | null = $state(null);
  let pasteOwnerId: string | null = $state(null);
  let isPasteOwner = $derived(pastebinIdForInline ? meId !== null && pasteOwnerId !== null && meId === pasteOwnerId : false);
  let canEdit = $derived(pastebinIdForInline ? isPasteOwner : uploadIdForEdit !== null);

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

  let hlLang: any = $state(plaintext);
  let pastebinIdForInline: string | null = $state(null);
  let pasteRawHref = $derived(pastebinIdForInline ? `/api/pastebins/${pastebinIdForInline}/raw` : displayUrl);
  let pasteViewerHref = $derived(pastebinIdForInline ? `/?/pastebin=${pastebinIdForInline}` : displayUrl);
  // edit-time highlight derived from filename input (so changing extension updates realtime)
  let editHlLang: any = $derived.by(() => {
    if (!editing) return hlLang;
    const name = editFilename.trim() || uploadName || '';
    if (name) return detectLang(name);
    return hlLang;
  });
  onMount(async () => {
    try { const me = await fetchMe(); meId = me.id; } catch {}
  });
  $effect(() => {
    hlLang = detectLang(url);
    void load();
  });

  async function load() {
    try {
      pastebinIdForInline = null;
      pasteOwnerId = null;
      // Pastebin inline: viewer URL (/?/pastebin=ID) or raw API (/api/pastebins/ID/raw)
      let pasteId: string | null = null;
      try {
        const u = new URL(url, location.origin);
        if (u.search.startsWith('?/pastebin=')) {
          const m = u.search.match(/^\?\/pastebin=([^&]+)/);
          if (m) pasteId = decodeURIComponent(m[1]);
        } else if (/^\/api\/pastebins\/[^\/]+\/raw\/?$/i.test(u.pathname)) {
          const m = u.pathname.match(/^\/api\/pastebins\/([^\/]+)\/raw\/?$/i);
          if (m) pasteId = decodeURIComponent(m[1]);
        } else if (/^\/api\/pastebins\/[^\/]+$/i.test(u.pathname) && !u.pathname.endsWith('/raw')) {
          // direct JSON GET without /raw might be used; treat as pastebin as well
          const m = u.pathname.match(/^\/api\/pastebins\/([^\/]+)\/?$/i);
          if (m && u.pathname.includes('/api/pastebins/')) pasteId = decodeURIComponent(m[1]);
        }
      } catch {}
      if (pasteId) {
        pastebinIdForInline = pasteId;
        const { fetchPastebinById } = await import('../stores/api');
        const rec = await fetchPastebinById(pasteId);
        const text = rec.body ?? '';
        const truncatedPaste = text.length > 50000 ? text.slice(0, 50000) + '\n\n… truncated …' : text;
        code = truncatedPaste;
        void afterCodeLoaded();
        uploadName = rec.name;
        pasteOwnerId = (rec as any).userId ?? null;
        // pick highlight based on syntax
        try {
          const lang = (rec.syntax || 'text').toLowerCase();
          const syntaxMap: Record<string, any> = {
            txt: plaintext, text: plaintext, log: plaintext,
            md: markdown, markdown,
            json, js: javascript, jsx: javascript, mjs: javascript, cjs: javascript,
            ts: typescript, tsx: typescript, mts: typescript, cts: typescript,
            py: python, python,
            java, c: cpp, h: cpp, cc: cpp, cpp, cxx: cpp, hpp: cpp,
            cs: csharp, csharp,
            go, rs: rust, rust, php, rb: ruby, ruby, sh: bash, bash, zsh: bash,
            yaml, yml: yaml,
            xml, html: xml, htm: xml,
            css, scss, less,
            sql, toml, ini,
            lua, perl, powershell, r: rlang, graphql, protobuf, twig, verilog, vhdl, zig,
            swift, kotlin, dart,
            dockerfile, makefile, nginx,
          };
          hlLang = syntaxMap[lang] ?? detectLang(rec.name || `file.${lang}`);
        } catch {}
        return;
      }
      let fetchUrl = url;
      try {
        const u = new URL(url, location.origin);
        if (u.pathname.startsWith('/uploads/')) fetchUrl = u.pathname + u.search + u.hash;
      } catch {}
      const res = await fetch(fetchUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const truncated = text.length > 50000 ? text.slice(0, 50000) + '\n\n… truncated …' : text;
      code = truncated;
      void afterCodeLoaded();
      try {
        const uPath = (()=>{ try{ return new URL(url, location.origin).pathname; } catch { return url; } })();
        const r2 = await fetchUploadsOffset(0, 100);
        for (const e of r2.entries) {
          let ePath: string;
          try { ePath = new URL(e.url).pathname; } catch { ePath = e.url; }
          if (ePath === uPath || e.url === url) { uploadName = e.name; uploadIdForEdit = e._id; break; }
        }
      } catch {}
    } catch (e) {
      console.warn('TextInline failed to load', url, e);
      errored = true;
    }
  }
  function snapToBottomIfNeeded(): void {
    const c = document.getElementById('messages') as HTMLElement | null;
    if (!c) return;
    const dist = c.scrollHeight - c.clientHeight - c.scrollTop;
    if (dist <= 300) {
      c.scrollTop = c.scrollHeight;
      requestAnimationFrame(() => { if (c) c.scrollTop = c.scrollHeight; });
    }
  }
  async function afterCodeLoaded(): Promise<void> {
    await tick();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    snapToBottomIfNeeded();
  }
  function onClose(e: MouseEvent) {
    e.preventDefault();
    closed = true;
  }

  function startEdit() {
    if (!canEdit) return;
    if (code === null) return;
    const urlName = (()=>{ try{ return new URL(url).pathname.split('/').pop() ?? url; }catch{ return url.split('/').pop() ?? url; }})();
    editFilename = uploadName ?? localName ?? urlName;
    editError = null;
    editing = true;
  }

  function cancelEdit() {
    editing = false;
    editError = null;
  }

  async function saveEdit() {
    if (!editFilename.trim()) {
      editError = 'Name cannot be empty';
      return;
    }
    // Pastebin inline edit
    if (pastebinIdForInline && isPasteOwner) {
      try {
        const { updatePastebin } = await import('../stores/api');
        // Need to determine syntax from editValue? Use current hlLang or keep original
        // For simplicity keep original syntax (from paste record) if available, else detect
        // We can re-detect via editFilename extension or keep 'text'
        let newSyntax = 'text';
        try {
          const ext = editFilename.split('.').pop()?.toLowerCase() ?? '';
          const map: Record<string,string> = { py:'python', js:'javascript', ts:'typescript', sh:'bash', json:'json', yaml:'yaml', md:'markdown', html:'xml', css:'css', sql:'sql' };
          newSyntax = map[ext] ?? 'text';
        } catch {}
        await updatePastebin(pastebinIdForInline, { name: editFilename.trim(), syntax: newSyntax, body: editValue });
        uploadName = editFilename.trim();
        localName = editFilename.trim();
        code = editValue;
        editing = false;
        editError = null;
        return;
      } catch (err: any) {
        editError = err?.message ?? 'Failed to save';
        return;
      } finally {
        editSaving = false;
      }
    }
    const uploadId: string | null = uploadIdForEdit;
    if (uploadId) {
      editSaving = true;
      try {
        await editUpload(uploadId, { content: editValue, filename: editFilename.trim() });
        uploadName = editFilename.trim();
        localName = editFilename.trim();
        code = editValue;
        editing = false;
        editError = null;
        return;
      } catch (err: any) {
        editError = err?.message ?? 'Failed to save';
        return;
      } finally {
        editSaving = false;
      }
    }
    localName = editFilename.trim();
    code = editValue;
    editing = false;
    editError = null;
  }
</script>

{#if !closed && !errored && code !== null}
  {@const urlFilename = (()=>{ try{ return new URL(url).pathname.split('/').pop() ?? url.split('/').pop() ?? url; } catch { return url.split('/').pop() ?? url; } })()}
  {@const filename = uploadName ?? localName ?? urlFilename}
  {@const lineCount = code.split('\n').length}
  {@const syntaxName = hlLang?.name ?? 'Plain Text'}
  <span class="directEmbedWrap textWrap paste" data-text-url={url}>
    <h1 class="header">
      {#if editing}
        <span class="details" style="display:flex; align-items:center; gap:6px; flex:1;">
          <label for="inline-edit-name" style="font-size:12px; color:#b0b0b0; white-space:nowrap;">Name</label>
          <input id="inline-edit-name" class="input nameInput" style="flex:1; max-width:200px; background:#2a2c2f; color:#e6e6e6; border:1px solid #4a4d50; border-radius:3px; padding:3px 6px; font-size:13px;" placeholder="e.g. index.html" title="Name for referencing" bind:value={editFilename} />
          <span class="detectedLang" style="font-size:11px; color:#8b949e; white-space:nowrap; background:#1a1d23; border:1px solid #2a2d33; border-radius:3px; padding:2px 6px;" title="Detected from extension">{editHlLang?.name ?? hlLang?.name ?? 'Plain Text'}</span>
          <button type="button" class="action" style="background:#4c83e8; color:#fff; border:1px solid #4c83e8; border-radius:3px; padding:3px 10px; font-size:12px; cursor:pointer;" onclick={saveEdit} disabled={editSaving}>{editSaving ? 'Saving...' : 'Save'}</button>
          <button type="button" class="cancel" style="background:#45484c; color:#fff; border:1px solid #2c2f35; border-radius:3px; padding:3px 10px; font-size:12px; cursor:pointer;" onclick={cancelEdit}>Cancel</button>
        </span>
        <span class="actions">
          <button class="link closeButton" onclick={onClose}>close</button>
        </span>
      {:else}
        <span class="details">
          {#if pastebinIdForInline}
            <a href={pasteViewerHref} class="name" style="color:#c9d1d9; text-decoration:none; font-weight:700;">{filename}</a>
          {:else}
            <span class="name">{filename}</span>
          {/if}
          <span class="info"><span class="syntax">{syntaxName}</span> • <span class="lines">{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span> </span>
          <span class="modes">{#if pastebinIdForInline}<a target="_blank" rel="noreferrer" href={pasteViewerHref}>view</a> • <a target="_blank" rel="noreferrer" href={pasteRawHref}>raw</a>{:else}<a target="_blank" rel="noreferrer" href={pasteRawHref}>raw</a>{/if} | <button class="link linesButton" onclick={() => gutterHidden = !gutterHidden}>line numbers</button> </span>
        </span>
        <span class="actions">
          {#if canEdit}
            <button class="link editButton" onclick={startEdit}>edit</button>
            •
          {/if}
          <button class="link closeButton" onclick={onClose}>close</button>
        </span>
      {/if}
    </h1>
    {#if editError}<p class="userError" style="color:#f85149; font-size:12px; margin:4px 0;">{editError}</p>{/if}
    {#if editing}
      {@const editLines = editValue.split('\n').length}
      <div class="editor editing" style="height: {Math.min(Math.max(editLines,1),12)*16 + 28}px; min-height: 44px;">
        <CodeEditor bind:value={editValue} language={editHlLang?.name?.toLowerCase() ?? hlLang?.name?.toLowerCase() ?? 'text'} />
      </div>
    {:else}
      <div class="editor" style="height: {Math.min(Math.max(lineCount,1),12)*16 + 28}px; min-height: 44px;">
        <div class="editorScroll">
          {#if !gutterHidden}
            <div class="gutter" aria-hidden="true">
              {#each { length: lineCount } as _, i}
                <div class="gutterCell">{i + 1}</div>
              {/each}
            </div>
          {/if}
          <Highlight language={hlLang} code={code} let:highlighted>
            <pre class="code hljs">{@html highlighted}</pre>
          </Highlight>
        </div>
      </div>
    {/if}
  </span>
{/if}

<style>
  .textWrap.paste {
    display: block;
    margin: 8px 0 12px;
    border: none;
    background: transparent;
    max-width: 100%;
  }
  .textWrap.paste .header {
    position: relative;
    margin: 0 0 6px;
    padding: 0;
    font-size: 14px;
    font-weight: 400;
    line-height: 20px;
    color: #d9d9d9;
    display: block;
  }
  .textWrap.paste .details .name { color: #fff; font-weight: 600; margin-right: 4px; }
  .textWrap.paste .details .info { color: #b0b0b0; margin-right: 4px; }
  .textWrap.paste .details a,
  .textWrap.paste .modes a { color: #58a6ff; text-decoration: none; }
  .textWrap.paste .details a:hover,
  .textWrap.paste .modes a:hover { text-decoration: underline; }
  .textWrap.paste .modes { color: #8b949e; font-size: 13px; }
  .textWrap.paste button.link {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    font-size: 13px;
    color: #58a6ff;
    cursor: pointer;
    vertical-align: baseline;
  }
  .textWrap.paste button.link:hover { text-decoration: underline; }
  .textWrap.paste .actions { float: right; color: #8b949e; font-size: 13px; }
  .textWrap.paste .editor {
    background-color: #141414;
    color: #F8F8F8;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace;
    font-size: 12px;
    line-height: 16px;
    overflow: hidden;
  }
  .textWrap.paste .editor .editorScroll { display: flex; align-items: stretch; height: 100%; overflow: auto; }
  .textWrap.paste .editor .gutter {
    position: sticky;
    left: 0;
    flex: 0 0 auto;
    min-width: 40px;
    padding: 0 13px 0 19px;
    box-sizing: border-box;
    background: #232323;
    color: #E2E2E2;
    text-align: right;
    user-select: none;
  }
  .textWrap.paste .editor .gutterCell { height: 16px; }
  .textWrap.paste .editor pre.code {
    flex: 1 0 auto;
    margin: 0;
    padding: 0 8px 0 4px;
    font: inherit;
    color: inherit;
    white-space: pre;
    letter-spacing: normal;
  }
  .textWrap.paste .editor :global(.hljs) {
    background: #141414;
    color: #F8F8F8;
    padding: 0;
  }
  .textWrap.paste .editor :global(.hljs-keyword),
  .textWrap.paste .editor :global(.hljs-meta) { color: #CDA869; }
  .textWrap.paste .editor :global(.hljs-string) { color: #8F9D6A; }
  .textWrap.paste .editor :global(.hljs-regexp) { color: #E9C062; }
  .textWrap.paste .editor :global(.hljs-comment) { color: #5F5A60; font-style: italic; }
  .textWrap.paste .editor :global(.hljs-variable) { color: #7587A6; }
  .textWrap.paste .editor :global(.hljs-tag),
  .textWrap.paste .editor :global(.hljs-name) { color: #AC885B; }
  .textWrap.paste .editor :global(.hljs-attr) { color: #7587A6; }
  .textWrap.paste .editor :global(.hljs-attribute) { color: #9B859D; }
  .textWrap.paste .editor :global(.hljs-title) { color: #AC885B; }
  .textWrap.paste .editor :global(.hljs-built_in) { color: #9B859D; }
  .textWrap.paste .editor :global(.hljs-number),
  .textWrap.paste .editor :global(.hljs-literal) { color: #CF6A4C; }
  .textWrap.paste .editor :global(.hljs-type) { color: #9B859D; }
  .textWrap.paste .editor :global(.hljs-selector-class),
  .textWrap.paste .editor :global(.hljs-selector-id) { color: #F9EE98; }
</style>
