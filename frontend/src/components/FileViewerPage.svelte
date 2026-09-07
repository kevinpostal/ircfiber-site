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

  // Grammar objects resolve via the shared registry (core bundled, rest on
  // demand) so the ~20 rarely-used grammars stay out of the vendor chunk.
  import { coreLanguage, ensureLanguage, languageNameForMode } from '../lib/highlightLanguages';
  let hlLangObj: any = $state(coreLanguage('plaintext'));
  let langToken = 0;
  $effect(() => {
    const name = languageNameForMode(highlightLang);
    const t = ++langToken;
    hlLangObj = coreLanguage(name) ?? coreLanguage('plaintext');
    if (coreLanguage(name)) return;
    void ensureLanguage(name).then((full) => { if (t === langToken) hlLangObj = full; });
  });

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
          <HtmlPreviewTabs url={entry.url} filename={entry.name} withFrame={true} highlightLang={hlLangObj} />
        {:else if isText}
          <HtmlPreviewTabs url={entry.url} filename={entry.name} withFrame={false} highlightLang={hlLangObj} />
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
