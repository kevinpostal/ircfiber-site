<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchUploadsOffset, deleteUpload, editUpload, type UploadEntry } from '../stores/api';
  import { sizeToString } from '../lib/upload';
  import CodeEditor from './CodeEditor.svelte';
  import { detectSyntaxFromFilename, isTextFile } from '../lib/textFiles';

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

  async function saveEdit(e: Event): Promise<void> {
    e.preventDefault();
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
      delete textPreviews[editingId];
      textPreviewErrors[editingId] = false;
      const fetchUrl = (() => { try { return new URL(entry.url).pathname; } catch { return entry.url; } })();
      try {
        const r = await fetch(fetchUrl);
        const t = await r.text();
        textPreviews[editingId] = t.slice(0, 1500);
      } catch {}
      editingId = null;
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
  <div id="filesOverlayContents">
    <div class="filesHeader">
      <h1 tabindex="0">File uploads <i class="spin {loading ? 'visible' : ''}"></i></h1>
      <button type="button" class="closeBtn" onclick={onClose}>Close</button>
    </div>

    <p class="loadingProgress userInfo" style="display: {loading && entries.length === 0 ? 'block' : 'none'};">Loading…</p>
    {#if error}
      <p class="loadingError userError">{error}</p>
    {/if}

    {#if entries.length > 0}
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
              {#if editingId === entry.id}
                {#if isTextFile(entry.mimeType, entry.name)}
                  <form action="" method="post" class="editForm" onsubmit={saveEdit}>
                    <CodeEditor bind:value={editingContent} language={editingLang} />
                    <p class="form">
                      <label for="editNameInput">Filename</label>
                      <input id="editNameInput" class="input nameInput" name="name" bind:value={editName} />
                    </p>
                    {#if editError}<p class="userError">{editError}</p>{/if}
                    <p class="form">
                      <button type="submit" class="action" disabled={saving}><span>{saving ? 'Saving…' : 'Save'}</span></button>
                      <button type="button" class="cancel" onclick={cancelEdit}><span>Cancel</span></button>
                    </p>
                  </form>
                {:else}
                  <div class="name" hidden>{entry.name}</div>
                  <form action="" method="post" class="editForm" onsubmit={saveEdit}>
                    <p class="form">
                      <label for="editNameInput">Filename</label>
                      <input id="editNameInput" class="input nameInput" name="name" bind:value={editName} />
                    </p>
                    {#if editError}<p class="userError">{editError}</p>{/if}
                    <p class="form">
                      <button type="submit" class="action" disabled={saving}><span>{saving ? 'Saving…' : 'Save'}</span></button>
                      <button type="button" class="cancel" onclick={cancelEdit}><span>Cancel</span></button>
                    </p>
                  </form>
                {/if}
              {:else}
                <div class="name">{entry.name}</div>
                <p class="link">{sizeToString(entry.size)} • {entry.mimeType}</p>
              {/if}
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
              {#if editingId === entry.id && editError}
                <p class="userError editError">{editError}</p>
              {/if}
              <span class="actions">
                <button type="button" class="edit" hidden={editingId === entry.id}
                        onclick={() => startEdit(entry)}><span>edit</span></button>
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
</style>
