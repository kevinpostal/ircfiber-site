<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchUploadsOffset, deleteUpload, type UploadEntry } from '../stores/api';
  import { sizeToString } from '../lib/upload';

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

  function startEdit(entry: UploadEntry): void {
    editingId = entry.id;
    editName = entry.name;
    editError = null;
  }

  function cancelEdit(): void {
    editingId = null;
    editError = null;
  }

  function saveEdit(e: Event): void {
    e.preventDefault();
    editError = 'Editing is not yet supported';
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
                <div class="name" hidden>{entry.name}</div>
                <form action="" method="post" class="editForm" onsubmit={saveEdit}>
                  <p class="form">
                    <textarea class="input nameInput" name="name" bind:value={editName}></textarea>
                  </p>
                  <p class="form">
                    <button type="submit" class="action"><span>Save</span></button>
                    <button type="button" class="cancel" onclick={cancelEdit}><span>Cancel</span></button>
                  </p>
                </form>
              {:else}
                <div class="name">{entry.name}</div>
                <p class="link">{sizeToString(entry.size)} • {entry.mimeType}</p>
              {/if}
            </div>
            <div class="preview">
              <a target="_blank" class="fileLink previewLink" href={entry.url}>
                <img class="filePreview" src={entry.url} alt={entry.name} loading="lazy" />
              </a>
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
