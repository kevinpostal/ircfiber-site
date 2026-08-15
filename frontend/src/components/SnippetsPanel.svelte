<script lang="ts">
  import { onMount } from 'svelte';
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
  import { fetchPastebinsOffset, updatePastebin, deletePastebin, pastebinRawUrl, type PasteEntry } from '../stores/api';
  import { ACE_MODES, aceModeLabel } from '../lib/aceModes';
  import { navigateToPastebin } from '../lib/routing';
  import CodeEditor from './CodeEditor.svelte';
  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  const PAGE_SIZE = 25;
  const LINE_HEIGHT = 16;
  const MAX_VISIBLE_LINES = 12;

  let entries = $state<PasteEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let total = $state(0);
  let totalPages = $derived(Math.max(1, Math.ceil(total / PAGE_SIZE)));
  let page = $state(1);

  let editingId = $state<string | null>(null);
  let editName = $state('');
  let editSyntax = $state('text');
  let editBody = $state('');
  let editError = $state<string | null>(null);
  let confirmingId = $state<string | null>(null);
  let saving = $state(false);
  // Per-paste "line numbers" toggle (gutter shown by default, like IRCCloud)
  let gutterHidden = $state<Record<string, boolean>>({});

  function getVisiblePages(current: number, totalP: number): (number | '...')[] {
    if (totalP <= 7) return Array.from({ length: totalP }, (_, i) => i + 1);
    const pages: (number | '...')[] = [];
    if (current <= 4) {
      for (let i = 1; i <= 3; i++) pages.push(i);
      pages.push('...');
      pages.push(totalP - 2, totalP - 1, totalP);
    } else if (current >= totalP - 3) {
      pages.push(1, 2, 3, '...');
      for (let i = totalP - 2; i <= totalP; i++) pages.push(i);
    } else {
      pages.push(1, 2, 3, '...', current - 1, current, current + 1, '...', totalP - 2, totalP - 1, totalP);
    }
    return pages;
  }

  async function loadPage(p: number): Promise<void> {
    loading = true;
    error = null;
    try {
      const result = await fetchPastebinsOffset((p - 1) * PAGE_SIZE, PAGE_SIZE);
      entries = result.entries;
      total = result.total;
      page = p;
    } catch (e) {
      error = 'Failed to load snippets. Please refresh the page and try again later.';
    } finally {
      loading = false;
    }
  }

  onMount(() => { loadPage(1); });

  function goToPage(p: number): void {
    if (p < 1 || p > totalPages || p === page) return;
    loadPage(p);
  }

  function startEdit(entry: PasteEntry): void {
    editingId = entry.id;
    confirmingId = null;
    editName = entry.name;
    editSyntax = entry.syntax || 'text';
    editBody = entry.body;
    editError = null;
  }

  function cancelEdit(): void {
    editingId = null;
    editError = null;
  }
  async function saveEdit(e: Event, entry: PasteEntry): Promise<void> {
    e.preventDefault();
    if (saving) return;
    saving = true;
    editError = null;
    try {
      const updated = await updatePastebin(entry.id, { name: editName, syntax: editSyntax, body: editBody });
      // Replace entry in array immutably to trigger Svelte 5 reactivity
      entries = entries.map(p => p.id === entry.id ? { ...p, name: updated.name, syntax: updated.syntax, body: updated.body, lines: updated.lines } : p);
      editingId = null;
    } catch (err) {
      editError = 'There was a problem editing this snippet';
    } finally {
      saving = false;
    }
  }



  async function confirmDelete(entry: PasteEntry): Promise<void> {
    try {
      await deletePastebin(entry.id);
      entries = entries.filter(p => p.id !== entry.id);
      total = Math.max(0, total - 1);
      confirmingId = null;
    } catch (err) {
      editError = 'There was a problem deleting this snippet';
    }
  }

  function editorHeight(entry: PasteEntry): number {
    return Math.min(Math.max(entry.lines, 1), MAX_VISIBLE_LINES) * LINE_HEIGHT;
  }

  function getHighlightLang(mode: string): any {
    const m = mode.toLowerCase();
    const map: Record<string, any> = {
      text: plaintext, plaintext: plaintext, txt: plaintext,
      html: xml, htm: xml, xhtml: xml, xml: xml, svg: xml,
      javascript: javascript, js: javascript, jsx: javascript, mjs: javascript, cjs: javascript,
      typescript: typescript, ts: typescript, tsx: typescript,
      python: python, py: python,
      java: java, c_cpp: cpp, c: cpp, cpp: cpp, cc: cpp, cxx: cpp, h: cpp, hpp: cpp,
      csharp: csharp, cs: csharp,
      go: go, golang: go,
      rust: rust, rs: rust,
      ruby: ruby, rb: ruby,
      php: php,
      swift: swift,
      kotlin: kotlin, kt: kotlin,
      dart: dart,
      css: css, scss: scss, less: less,
      json: json, json5: json,
      yaml: yaml, yml: yaml,
      markdown: markdown, md: markdown,
      sql: sql, toml: toml, ini: ini,
      sh: bash, bash: bash, shell: bash, zsh: bash,
      lua: lua, perl: perl, powershell: powershell, r: rlang,
      graphql: graphql, graphqlschema: graphql,
      protobuf: protobuf,
      twig: twig, verilog: verilog, vhdl: vhdl, zig: zig,
      dockerfile: dockerfile, makefile: makefile, nginx: nginx,
    };
    return map[m] ?? null;
  }

  function formatDate(ms: number): string {
    const d = new Date(ms);
    // Two calls joined by a space: IRCCloud has no "at" between date and time
    const date = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true });
    return `${date} ${time}`;
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (editingId) cancelEdit();
      else if (confirmingId) confirmingId = null;
      else onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div id="pastebinsContainer" class="mainOverlay">
  <div id="pastebinsOverlayContents" class="mainOverlayContent">
    <button type="button" class="close" onclick={onClose}><span>Close</span></button>
    <h1 tabindex="0">Text snippets <i class="spin {loading ? 'visible' : ''}"></i></h1>
    <p class="loadingProgress userInfo" style="display: {loading && entries.length === 0 ? 'block' : 'none'};">Loading…</p>
    {#if error}
      <p class="loadingError userError">{error}</p>
    {/if}

    {#snippet pagination()}
      {@const visiblePages = getVisiblePages(page, totalPages)}
      <ul class="pagination">
        {#if totalPages > 1}
          <li class:disabled={page === 1}>
            <a href="#" onclick={(e) => { e.preventDefault(); goToPage(page - 1); }}>«</a>
          </li>
          {#each visiblePages as p}
            {#if p === '...'}
              <li class="ellipsis"><a href="#" onclick={(e) => e.preventDefault()}>…</a></li>
            {:else}
              <li class:enabled={p !== page} class:active={p === page}>
                <a href="#" onclick={(e) => { e.preventDefault(); goToPage(p); }}>{p}</a>
              </li>
            {/if}
          {/each}
          <li class:disabled={page === totalPages}>
            <a href="#" onclick={(e) => { e.preventDefault(); goToPage(page + 1); }}>»</a>
          </li>
        {/if}
      </ul>
    {/snippet}

    {@render pagination()}

    <div id="pastebinList">
      {#each entries as entry (entry.id)}
        <div class="paste">
          <h1 class="header">
            {#if editingId === entry.id}
              <form action="" method="post" class="editForm" onsubmit={(e) => saveEdit(e, entry)}>
                <p class="form">
                  <label for="edit-name-{entry.id}" style="font-size:12px; color:#b0b0b0; margin-right:4px;">Name</label>
                  <input id="edit-name-{entry.id}" class="input nameInput" name="name" placeholder="e.g. index.html" title="Name for referencing (shown in header)" bind:value={editName} />
                  <select name="aceMode" bind:value={editSyntax} aria-label="Syntax">
                    {#each ACE_MODES as [value, label]}
                      <option {value}>{label}</option>
                    {/each}
                  </select>
                  <button type="submit" class="action" disabled={saving}><span>Save</span></button>
                  <button type="button" class="cancel" onclick={cancelEdit}><span>Cancel</span></button>
                </p>
              </form>
            {:else}
              <span class="details">
                <span class="name">{entry.name}</span>
                <span class="info"><span class="syntax">{aceModeLabel(entry.syntax)}</span> • <span class="lines">{entry.lines} {entry.lines === 1 ? 'line' : 'lines'}</span> </span>
                <a target="_blank" rel="noreferrer" href={pastebinRawUrl(entry.id)} class="date" title={new Date(entry.createdAt).toISOString()}>{formatDate(entry.createdAt)}</a>
                <span class="modes"><a target="_blank" rel="noreferrer" href={pastebinRawUrl(entry.id)}>raw</a> | <button class="link linesButton" onclick={() => gutterHidden[entry.id] = !gutterHidden[entry.id]}>line numbers</button> </span>
              </span>
              {#if confirmingId === entry.id}
                <span class="confirm">
                  <span class="explanation">Are you sure?</span>
                  <button type="button" class="delete" onclick={() => confirmDelete(entry)}><span>Yup, trash it</span></button>
                  <button type="button" class="cancel" onclick={() => confirmingId = null}><span>Cancel</span></button>
                </span>
              {:else}
                <span class="actions">
                  <button class="link viewButton" onclick={() => navigateToPastebin(entry.id)}>view</button>
                  •
                  <button class="link editButton" onclick={() => startEdit(entry)}>edit</button>
                  •
                  <button class="link deleteButton" onclick={() => { confirmingId = entry.id; editError = null; }}>delete</button>
                </span>
              {/if}
            {/if}
            {#if editError && (editingId === entry.id || confirmingId === entry.id)}
              <p class="userError editError">{editError}</p>
            {/if}
          </h1>
          {#if editingId === entry.id}
            <div class="editor editing" style="height: {Math.min(Math.max(editBody.split('\n').length, 1), MAX_VISIBLE_LINES) * LINE_HEIGHT + 28}px; min-height: 44px;">
              <CodeEditor bind:value={editBody} language={editSyntax} />
            </div>
          {:else}
            <div class="editor" class:noGutter={gutterHidden[entry.id]} style="height: {editorHeight(entry) + 28}px; min-height: 44px;">
              <div class="editorScroll">
                {#if !gutterHidden[entry.id]}
                  <div class="gutter" aria-hidden="true">
                    {#each { length: entry.lines } as _, i}
                      <div class="gutterCell">{i + 1}</div>
                    {/each}
                  </div>
                {/if}
                {#if getHighlightLang(entry.syntax)}
                  <Highlight language={getHighlightLang(entry.syntax)} code={entry.body} let:highlighted>
                    <pre class="code hljs">{@html highlighted}</pre>
                  </Highlight>
                {:else}
                  <pre class="code">{entry.body}</pre>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        {#if !loading && !error}
          <p class="emptyMsg">No text snippets yet.</p>
        {/if}
      {/each}
    </div>

    {@render pagination()}
  </div>
</div>

<style>
  /* Twilight overrides for svelte-highlight to match IRCCloud's ace-twilight */
  :global(#pastebinList .paste .editor .hljs) {
    background: #141414;
    color: #F8F8F8;
    padding: 0;
  }
  :global(#pastebinList .paste .editor .hljs-keyword),
  :global(#pastebinList .paste .editor .hljs-meta),
  :global(#pastebinList .paste .editor .hljs-selector-tag) {
    color: #CDA869;
  }
  :global(#pastebinList .paste .editor .hljs-string),
  :global(#pastebinList .paste .editor .hljs-attr .hljs-string) {
    color: #8F9D6A;
  }
  :global(#pastebinList .paste .editor .hljs-regexp) {
    color: #E9C062;
  }
  :global(#pastebinList .paste .editor .hljs-comment) {
    color: #5F5A60;
    font-style: italic;
  }
  :global(#pastebinList .paste .editor .hljs-variable),
  :global(#pastebinList .paste .editor .hljs-template-variable) {
    color: #7587A6;
  }
  :global(#pastebinList .paste .editor .hljs-tag),
  :global(#pastebinList .paste .editor .hljs-name) {
    color: #AC885B;
  }
  :global(#pastebinList .paste .editor .hljs-attr) {
    color: #7587A6;
  }
  :global(#pastebinList .paste .editor .hljs-attribute) {
    color: #9B859D;
  }
  :global(#pastebinList .paste .editor .hljs-title.function),
  :global(#pastebinList .paste .editor .hljs-title) {
    color: #AC885B;
  }
  :global(#pastebinList .paste .editor .hljs-built_in) {
    color: #9B859D;
  }
  :global(#pastebinList .paste .editor .hljs-number),
  :global(#pastebinList .paste .editor .hljs-literal) {
    color: #CF6A4C;
  }
  :global(#pastebinList .paste .editor .hljs-type) {
    color: #9B859D;
  }
  :global(#pastebinList .paste .editor .hljs-selector-class),
  :global(#pastebinList .paste .editor .hljs-selector-id) {
    color: #F9EE98;
  }
  :global(#pastebinList .paste .editor .hljs-doctag) {
    color: #494949;
  }
</style>
