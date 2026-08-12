<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchUploadById, editUpload, type UploadEntry } from '../stores/api';
  import { isHtmlFile, isTextFile, detectSyntaxFromFilename } from '../lib/textFiles';
  import HtmlPreviewTabs from './HtmlPreviewTabs.svelte';
  import CodeEditor from './CodeEditor.svelte';
  import { sizeToString } from '../lib/upload';
  import { getFileViewerIdFromUrl, navigateBackFromFileViewer } from '../lib/routing';

  interface Props {
    id?: string;
    onClose?: () => void;
  }
  let { id: propId, onClose }: Props = $props();

  let id = $derived(propId ?? getFileViewerIdFromUrl() ?? '');
  let entry = $state<UploadEntry | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let editing = $state(false);
  let editContent = $state('');
  let editFilename = $state('');
  let editLang = $state('text');
  let saving = $state(false);
  let editError = $state<string | null>(null);
  let copied = $state(false);

  let isHtml = $derived(entry ? isHtmlFile(entry.mimeType, entry.name) : false);
  let isText = $derived(entry ? isTextFile(entry.mimeType, entry.name) : false);
  let highlightLang = $derived(entry ? detectSyntaxFromFilename(entry.name) : 'text');

  // Map detectSyntax to svelte-highlight languages via lazy? Pass string to HtmlPreviewTabs which maps xml fallback, but for text we want proper highlight.
  // HtmlPreviewTabs expects highlightLang any; we pass null and let it fallback to xml for html, for text we need actual language mapping similar to TextInline.
  import plaintext from 'svelte-highlight/languages/plaintext';
  import python from 'svelte-highlight/languages/python';
  import javascript from 'svelte-highlight/languages/javascript';
  import typescript from 'svelte-highlight/languages/typescript';
  import bash from 'svelte-highlight/languages/bash';
  import jsonLang from 'svelte-highlight/languages/json';
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
  // Resolve string mode to language
  function langFromMode(mode: string): any {
    const map: Record<string, any> = {
      text: plaintext, python, javascript, typescript, bash, sh: bash,
      yaml, json: jsonLang, markdown, html: xml, css, scss, less, sql, xml,
      java, c_cpp: cpp, csharp, golang: go, rust, ruby, php, swift, kotlin, dart, ini, dockerfile, makefile,
    };
    return map[mode] ?? plaintext;
  }
  let resolvedLang = $derived(langFromMode(highlightLang));

  let displayUrl = $derived(entry ? (() => { try { const u = new URL(entry!.url, location.origin); if (u.pathname.startsWith('/uploads/')) return u.pathname + u.search + u.hash; } catch {} return entry!.url; })() : '');
  let downloadHref = $derived(entry ? (displayUrl + (displayUrl.includes('?') ? '&' : '?') + 'download=1') : '');

  async function load() {
    if (!id) { loading = false; error = 'Missing id'; return; }
    loading = true;
    error = null;
    try {
      const rec = await fetchUploadById(id);
      entry = rec;
      editFilename = rec.name;
      editLang = detectSyntaxFromFilename(rec.name);
      // preload content for edit
      if (isTextFile(rec.mimeType, rec.name)) {
        try {
          const fetchPath = (() => { try { const u = new URL(rec.url, location.origin); return u.pathname; } catch { return rec.url; } })();
          const r = await fetch(fetchPath);
          if (r.ok) editContent = await r.text();
        } catch {}
      }
    } catch (e: any) {
      error = e?.message ?? 'Failed to load';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editing) editing = false;
        else (onClose ?? navigateBackFromFileViewer)();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  $effect(() => {
    // reload if id changes
    void id;
    void load();
  });

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(entry?.url ?? displayUrl);
      copied = true;
      setTimeout(() => copied = false, 1500);
    } catch {}
  }

  async function saveEdit(e: SubmitEvent) {
    e.preventDefault();
    if (!entry) return;
    saving = true;
    editError = null;
    try {
      await editUpload(entry.id, { content: editContent, filename: editFilename });
      entry = { ...entry, name: editFilename };
      editing = false;
      // reload to refresh preview
      await load();
    } catch (err: any) {
      editError = err?.message ?? 'Save failed';
    } finally {
      saving = false;
    }
  }

  function handleClose() {
    if (onClose) onClose();
    else navigateBackFromFileViewer();
  }
</script>

<svelte:window onkeydown={(e)=>{ if(e.key==='Escape' && !editing) handleClose(); }} />

<div id="fileViewerPage">
  <div id="filesContainer">
    <div id="filesOverlayContents">
      {#if loading}
        <p class="loadingProgress userInfo">Loading…</p>
      {:else if error || !entry}
        <div class="filesHeader">
          <h1>File viewer</h1>
          <button type="button" class="closeBtn" onclick={handleClose}>Close</button>
        </div>
        <p class="userError">{error ?? 'Not found.'} <button onclick={handleClose}>Back</button></p>
      {:else}
        <div class="filesHeader">
          <h1 title={entry.name}>{entry.name}</h1>
          <button type="button" class="closeBtn" onclick={handleClose}>Close</button>
        </div>
        <div class="fileViewerMeta">
          <span class="fileMetaSize">{sizeToString(entry.size)}</span>
          <span class="fileMetaMime">{entry.mimeType}</span>
          <button type="button" class="copyBtn" onclick={copyLink}>{copied ? 'Copied!' : 'Copy link'}</button>
          <a class="downloadBtn" href={downloadHref} download={entry.name}>Download</a>
          {#if isText}
            <button type="button" class="editBtn" onclick={() => editing = !editing}>{editing ? 'Cancel edit' : 'Edit'}</button>
          {/if}
          <a class="openBtn" href={displayUrl} target="_blank" rel="noreferrer">Open</a>
        </div>

        {#if editing}
          <div class="editFullPage pastebin">
            <div class="editFileInfo">
              <label>Filename <input bind:value={editFilename} /></label>
              <span class="editLang">{editLang}</span>
            </div>
            <div class="pastebinWrapper editEditorWrapper">
              <CodeEditor bind:value={editContent} language={editLang} />
            </div>
            {#if editError}<p class="userError">{editError}</p>{/if}
            <form class="editFormFull" onsubmit={saveEdit}>
              <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              <button type="button" onclick={() => editing = false}>Cancel</button>
            </form>
          </div>
        {:else if isHtml}
          <HtmlPreviewTabs url={entry.url} filename={entry.name} withFrame={true} highlightLang={resolvedLang} />
        {:else if isText}
          <HtmlPreviewTabs url={entry.url} filename={entry.name} withFrame={false} highlightLang={resolvedLang} />
        {:else}
          <div class="unsupportedBox">
            <p>Unsupported type: {entry.mimeType}</p>
            {#if entry.mimeType.startsWith('image/')}
              <img src={displayUrl} alt={entry.name} style="max-width:100%;border:1px solid #2a2d33;border-radius:4px;" />
            {/if}
            <p><a href={displayUrl} target="_blank" rel="noreferrer">Open file</a> | <a href={downloadHref} download={entry.name}>Download</a></p>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  #fileViewerPage { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; background: rgba(15,17,21,0.9); backdrop-filter: blur(4px); }
  #fileViewerPage #filesContainer { flex: 1; overflow: auto; display: flex; justify-content: center; padding: 24px; }
  #fileViewerPage #filesOverlayContents { background: #0f1115; border: 1px solid #2a2d33; border-radius: 8px; width: 100%; max-width: 960px; padding: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
  .filesHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .filesHeader h1 { font-size: 18px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .closeBtn { padding: 6px 12px; border: 1px solid #2a2d33; border-radius: 4px; background: #161a22; color: #c9d1d9; cursor: pointer; }
  .fileViewerMeta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; font-size: 12px; color: #8b949e; }
  .copyBtn, .editBtn, .downloadBtn, .openBtn { padding: 4px 8px; border: 1px solid #2a2d33; border-radius: 4px; background: #161a22; color: #c9d1d9; cursor: pointer; text-decoration: none; font-size: 12px; }
  .unsupportedBox { padding: 20px; text-align: center; color: #8b949e; }
  .editFullPage { display: flex; flex-direction: column; gap: 12px; }
  .editFileInfo { display: flex; gap: 8px; align-items: center; }
  .editFileInfo input { flex: 1; padding: 6px 8px; background: #0d1117; border: 1px solid #2a2d33; border-radius: 4px; color: #c9d1d9; }
  .pastebinWrapper { border: 1px solid #2a2d33; border-radius: 4px; overflow: hidden; min-height: 200px; }
  .editFormFull { display: flex; gap: 8px; }
  .editFormFull button { padding: 6px 12px; border-radius: 4px; border: 1px solid #2a2d33; cursor: pointer; }
  .editFormFull button[type="submit"] { background: #1f6feb; color: white; border-color: #1f6feb; }
</style>
