<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchUploadsOffset, deleteUpload, editUpload, type UploadEntry } from '../stores/api';
  import { sizeToString } from '../lib/upload';
  import CodeEditor from './CodeEditor.svelte';
  import { detectSyntaxFromFilename, isTextFile } from '../lib/textFiles';

  const EDIT_LANGUAGES = [
    'text','python','javascript','typescript','bash','sh','yaml','json','markdown','html','css','sql','go','rust','java','php','ruby','dockerfile','ini','xml','c_cpp','csharp','golang','graphqlschema','toml','ini','nginx','makefile','perl','swift','kotlin','yaml','json5'
  ] as const;

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let entries = $state<UploadEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let total = $state(0);
  let totalPages = $derived(Math.max(1, Math.ceil(total / 25)));
  let page = $state(1);
  const PAGE_SIZE = 25;
  let editingId = $state<string | null>(null);
  let editName = $state('');
  let editError = $state<string | null>(null);
  let editingContent = $state('');
  let editingLang = $state('text');
  let saving = $state(false);

  // Derived for full-page edit view
  let editingEntry = $derived(entries.find((e) => e.id === editingId) ?? null);

  // Text preview cache — fetched once per text file, truncated to 1500 chars
  let textPreviews = $state<Record<string, string>>({});
  let textPreviewErrors = $state<Record<string, boolean>>({});


  $effect(() => {
    // Fetch text previews for visible text files. Guard prevents re-fetch.
    for (const entry of entries) {
      const id = entry.id;
      if (!isTextFile(entry.mimeType, entry.name)) continue;
      if (id in textPreviews || textPreviewErrors[id]) continue;
      const fetchUrl = (() => { try { return new URL(entry.url).pathname; } catch { return entry.url; } })();
      fetch(fetchUrl).then((r) => {
        if (!r.ok) throw new Error('fetch failed');
        return r.text();
      }).then((t) => {
        textPreviews[id] = t.slice(0, 1500);
      }).catch(() => {
        textPreviewErrors[id] = true;
      });
    }
  });

  function getVisiblePages(current: number, total: number): (number | '...')[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages: (number | '...')[] = [];
    if (current <= 4) {
      for (let i = 1; i <= 3; i++) pages.push(i);
      pages.push('...');
      pages.push(total - 2, total - 1, total);
    } else if (current >= total - 3) {
      pages.push(1, 2, 3, '...');
      for (let i = total - 2; i <= total; i++) pages.push(i);
    } else {
      pages.push(1, 2, 3, '...', current - 1, current, current + 1, '...', total - 2, total - 1, total);
    }
    return pages;
  }

  async function loadPage(p: number): Promise<void> {
    loading = true;
    error = null;
    try {
      const offset = (p - 1) * PAGE_SIZE;
      const result = await fetchUploadsOffset(offset, PAGE_SIZE);
      entries = result.entries;
      total = result.total;
      page = p;
    } catch (e) {
      error = 'Failed to load files. Please refresh the page and try again later.';
    } finally {
      loading = false;
    }
  }

  onMount(() => { loadPage(1); });

  function goToPage(p: number): void {
    if (p < 1 || p > totalPages || p === page) return;
    loadPage(p);
  }

  async function startEdit(entry: UploadEntry): Promise<void> {
    editingId = entry.id;
    editName = entry.name;
    editError = null;
    saving = false;
    if (isTextFile(entry.mimeType, entry.name)) {
      try {
        const fetchUrl = (() => { try { return new URL(entry.url).pathname; } catch { return entry.url; } })();
        const r = await fetch(fetchUrl);
        if (!r.ok) throw new Error('fetch failed');
        editingContent = await r.text();
        editingLang = detectSyntaxFromFilename(entry.name);
      } catch {
        editingContent = '';
        editError = 'Failed to load file content';
      }
    } else {
      editingContent = '';
      editingLang = 'text';
    }
  }

  function cancelEdit(): void {
    editingId = null;
    editError = null;
    editingContent = '';
    editName = '';
    saving = false;
  }

  async function saveEdit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (!editingId) return;
    const entry = entries.find((en) => en.id === editingId);
    if (!entry) return;
    if (!editName.trim()) {
      editError = 'Filename required';
      return;
    }
    const wasTextFile = isTextFile(entry.mimeType, entry.name);
    if (!wasTextFile) {
      editError = 'Only text files can be edited';
      return;
    }
    saving = true;
    editError = null;
    try {
      await editUpload(editingId, { content: editingContent, filename: editName });
      entry.name = editName;
      entries = [...entries];
      const savedId = editingId;
      editingId = null;
      delete textPreviews[savedId];
      textPreviewErrors[savedId] = false;
      const fetchUrl = (() => { try { return new URL(entry.url).pathname; } catch { return entry.url; } })();
      try {
        const r = await fetch(fetchUrl, { cache: 'no-store' });
        const t = await r.text();
        textPreviews[savedId] = t.slice(0, 1500);
      } catch {}
    } catch (err) {
      editError = err instanceof Error ? err.message : 'Failed to save';
    } finally {
      saving = false;
    }
  }
  async function handleDelete(entry: UploadEntry): Promise<void> {
    try {
      await deleteUpload(entry.id);
      entries = entries.filter(e => e.id !== entry.id);
      total = Math.max(0, total - 1);
    } catch (e) {
      console.error('Delete failed', e);
    }
  }

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true,
    });
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (editingId) cancelEdit();
      else onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div id="filesContainer">
  <div id="filesOverlayContents" class:editing={!!editingId}>
    <div class="filesHeader">
      <h1 tabindex="0">File uploads <i class="spin {loading ? 'visible' : ''}"></i></h1>
      <button type="button" class="closeBtn" onclick={onClose}>Close</button>
    </div>

    <p class="loadingProgress userInfo" style="display: {loading && entries.length === 0 ? 'block' : 'none'};">Loading…</p>
    {#if error}
      <p class="loadingError userError">{error}</p>
    {/if}

    {#if editingId && editingEntry}
      <!-- Full-page edit view — styled like the upload snippet dialog (pastebin) -->
      <div class="editFullPage pastebin">
        <div class="pastebinHeader">
          <h1>Edit file</h1>
          <span class="pastebinSelect">
            <label for="editLangSelect">Syntax</label>
            <select id="editLangSelect" bind:value={editingLang} aria-label="Language">
              {#each EDIT_LANGUAGES as L}
                <option value={L}>{L === 'text' ? 'Plain Text' : L}</option>
              {/each}
            </select>
          </span>
        </div>
        <div class="editFileInfo">
          <span class="editFileName">{editingEntry.name}</span>
          <span class="editFileMeta">{editingEntry.mimeType} • {sizeToString(editingEntry.size)}</span>
        </div>
        {#if isTextFile(editingEntry.mimeType, editingEntry.name)}
          <div class="pastebinWrapper editEditorWrapper">
            <CodeEditor bind:value={editingContent} language={editingLang} />
          </div>
          <form class="editFormFull" onsubmit={saveEdit}>
            <div class="editFilenameSection">
              <label for="editNameInputFull" class="editFilenameLabel">
                <span class="labelMain">Filename</span>
                <span class="labelHint">extension sets syntax highlighting</span>
              </label>
              <div class="editFilenameInputWrap">
                <span class="filenameIcon">📄</span>
                <input id="editNameInputFull" class="input nameInput editFilenameInput" name="name" bind:value={editName} placeholder="example.py" spellcheck="false" autocomplete="off" />
              </div>
            </div>
            {#if editError}<p class="userError editErrorFull">{editError}</p>{/if}
            <p class="form editActions">
              <button type="submit" class="action confirm" disabled={saving}><span>{saving ? 'Saving…' : 'Save'}</span></button>
              <button type="button" class="cancel close" onclick={cancelEdit} disabled={saving}><span>Cancel</span></button>
            </p>
            <p class="pasteConfirm__help">
              <button type="button" class="linkBtn backBtn" onclick={cancelEdit}>← Back to files</button>
            </p>
          </form>
        {:else}
          <div class="editNonTextInfo">
            <p class="userInfo">Only text files can have their content edited. You can still rename this file.</p>
          </div>
          <form class="editFormFull" onsubmit={saveEdit}>
            <div class="editFilenameSection">
              <label for="editNameInputFull" class="editFilenameLabel">
                <span class="labelMain">Filename</span>
                <span class="labelHint">renaming changes syntax highlighting</span>
              </label>
              <div class="editFilenameInputWrap">
                <span class="filenameIcon">📄</span>
                <input id="editNameInputFull" class="input nameInput editFilenameInput" name="name" bind:value={editName} spellcheck="false" autocomplete="off" />
              </div>
            </div>
            {#if editError}<p class="userError">{editError}</p>{/if}
            <p class="form editActions">
              <button type="submit" class="action confirm" disabled={saving}><span>{saving ? 'Saving…' : 'Save'}</span></button>
              <button type="button" class="cancel close" onclick={cancelEdit}><span>Cancel</span></button>
            </p>
            <p class="pasteConfirm__help">
              <button type="button" class="linkBtn backBtn" onclick={cancelEdit}>← Back to files</button>
            </p>
          </form>
        {/if}
      </div>
    {:else if entries.length > 0}
      {@const visiblePages = getVisiblePages(page, totalPages)}
      <ul class="pagination">
        <li class:disabled={page === 1}>
          <a href="#" onclick={(e) => { e.preventDefault(); goToPage(page - 1); }}>«</a>
        </li>
        {#each visiblePages as p}
          {#if p === '...'}
            <li class="ellipsis"><a href="#" onclick={(e) => e.preventDefault()}>…</a></li>
          {:else}
            <li class:enabled={p !== page} class:active={p === page} class:left={p === 1} class:right={p === totalPages}>
              <a href="#" onclick={(e) => { e.preventDefault(); goToPage(p); }}>{p}</a>
            </li>
          {/if}
        {/each}
        <li class:disabled={page === totalPages}>
          <a href="#" onclick={(e) => { e.preventDefault(); goToPage(page + 1); }}>»</a>
        </li>
      </ul>

      <div id="filesList">
        {#each entries as entry (entry.id)}
          <div class="file">
            <div class="info">
              <p class="date">{formatDate(entry.createdAt)}</p>
              <div class="name">{entry.name}</div>
              <p class="link">{sizeToString(entry.size)} • {entry.mimeType}</p>
            </div>
            <div class="preview">
              {#if isTextFile(entry.mimeType, entry.name)}
                {#if textPreviews[entry.id]}
                  <a target="_blank" class="fileLink previewLink textPreviewLink" href={entry.url} title={entry.name}>
                    <pre class="textFilePreview">{textPreviews[entry.id]}</pre>
                  </a>
                {:else if textPreviewErrors[entry.id]}
                  <a target="_blank" class="fileLink previewLink" href={entry.url}>
                    <span class="fileIcon">📄</span> {entry.name}
                  </a>
                {:else}
                  <span class="loadingPreview">Loading preview…</span>
                {/if}
              {:else}
                <a target="_blank" class="fileLink previewLink" href={entry.url}>
                  <img class="filePreview" src={entry.url} alt={entry.name} loading="lazy" />
                </a>
              {/if}
              <span class="actions">
                <button type="button" class="edit" onclick={() => startEdit(entry)}><span>edit</span></button>
                <button type="button" class="delete" onclick={() => handleDelete(entry)}>
                  <span>delete</span>
                </button>
                <button type="button" class="restore" hidden><span>restore</span></button>
              </span>
            </div>
          </div>
        {/each}
      </div>
    {:else if !loading && !error}
      <p class="emptyMsg">No uploads yet. Drag an image onto the chat to upload.</p>
    {/if}
  </div>
</div>

<style>
  .textFilePreview {
    display: block;
    max-height: 180px;
    overflow: auto;
    background: #1e1e1e;
    color: #e6e6e6;
    padding: 10px;
    border-radius: 3px;
    font-family: 'Hack', 'SF Mono', Menlo, monospace;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    text-align: left;
    border: 1px solid #2c2f35;
  }
  .loadingPreview {
    color: #8b949e;
    font-size: 12px;
    padding: 20px;
    display: block;
    text-align: center;
  }
  #filesOverlayContents.editing {
    background: #131418;
    border: 1px solid #2c2f35;
    border-radius: 10px;
    overflow: visible;
    position: relative;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
  }
  #filesContainer:has(#filesOverlayContents.editing) {
    overflow-y: auto;
  }
  #filesOverlayContents.editing::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, #58a6ff, #8b5cf6);
    z-index: 2;
    border-radius: 10px 10px 0 0;
  }
  .editFullPage.pastebin {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    overflow: visible;
    box-shadow: none;
    max-height: none;
  }
  .editFullPage .pastebinHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 20px 12px;
    background: linear-gradient(135deg, #1a1d25 0%, #131418 100%);
    border-bottom: 1px solid #2c2f35;
    position: relative;
  }
  .editFullPage .pastebinHeader h1 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    color: #e6edf3;
  }
  .editFullPage .pastebinSelect {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 4px 6px 4px 10px;
    transition: border-color 0.15s, background 0.15s;
  }
  .editFullPage .pastebinSelect:hover {
    border-color: #30363d;
    background: #161b22;
  }
  .editFullPage .pastebinSelect label {
    color: #8b949e;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }
  .editFullPage .pastebinSelect select {
    background: #161b22;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 28px 6px 10px;
    font-size: 12px;
    font-weight: 500;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238b949e' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    cursor: pointer;
    min-width: 130px;
    transition: all 0.15s ease;
  }
  .editFullPage .pastebinSelect select:hover {
    border-color: #58a6ff;
    background-color: #1c2128;
    color: #fff;
  }
  .editFullPage .pastebinSelect select:focus {
    outline: none;
    border-color: #58a6ff;
    box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.2);
    background-color: #1c2128;
  }
  .editFullPage .pastebinSelect select option {
    background: #0d1117;
    color: #e6edf3;
  }
  .editFileInfo {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 20px;
    font-size: 12px;
    color: #8b949e;
    border-bottom: 1px solid #2c2f35;
    background: #0d1117;
  }
  .editFileName {
    font-weight: 600;
    color: #e6edf3;
    word-break: break-all;
  }
  .editFileMeta {
    color: #8b949e;
  }
  .editEditorWrapper {
    flex: 1 1 auto;
    min-height: 320px;
    max-height: min(60vh, 600px);
    margin: 12px 20px 8px;
    border: 1px solid #2c2f35;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    background: #282c34;
  }
  .editEditorWrapper :global(.codeEditor) {
    flex: 1 1 auto;
    min-height: 0;
  }
  .editFormFull {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 20px 16px;
    background: #0d1117;
    border-top: 1px solid #21262d;
    margin-top: 4px;
  }
  .editFormFull .form {
    margin: 0;
  }
  .editFormFull .buttons,
  .editFormFull .editActions {
    display: flex;
    gap: 8px;
    margin: 8px 0 0;
  }
  .editFilenameSection {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: #010409;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 12px;
  }
  .editFilenameLabel {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #8b949e;
  }
  .editFilenameLabel .labelMain {
    color: #e6edf3;
    font-size: 12px;
    text-transform: none;
    letter-spacing: normal;
    font-weight: 600;
  }
  .editFilenameLabel .labelHint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    color: #6e7681;
    font-size: 11px;
  }
  .editFilenameInputWrap {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 0 10px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .editFilenameInputWrap:focus-within {
    border-color: #58a6ff;
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.15);
  }
  .filenameIcon {
    color: #8b949e;
    font-size: 14px;
    flex-shrink: 0;
  }
  .editFilenameInput {
    flex: 1 1 auto;
    background: transparent !important;
    border: none !important;
    padding: 8px 0 !important;
    font-family: 'Hack', 'SF Mono', Menlo, monospace;
    font-size: 13px;
    color: #e6edf3;
    outline: none;
    box-shadow: none !important;
  }
  .editFilenameInput::placeholder {
    color: #484f58;
  }
  .editFormFull .action.confirm {
    background: #238636;
    color: #fff;
    border: 1px solid #2ea043;
    border-radius: 6px;
    padding: 6px 16px;
    font-weight: 600;
    cursor: pointer;
  }
  .editFormFull .action.confirm:hover {
    background: #2ea043;
  }
  .editFormFull .close {
    background: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 16px;
    cursor: pointer;
  }
  .editFormFull .pasteConfirm__help {
    text-align: center;
    font-size: 12px;
    color: #8b949e;
    margin: 4px 0 0;
  }
  .editFormFull .linkBtn.backBtn {
    background: none;
    border: none;
    color: #58a6ff;
    cursor: pointer;
    font-size: 12px;
  }
  .editFormFull .linkBtn.backBtn:hover {
    text-decoration: underline;
  }
  .editErrorFull {
    margin: 0;
    color: #f85149;
    font-size: 12px;
  }
  .editNonTextInfo {
    padding: 16px 20px;
  }
</style>
