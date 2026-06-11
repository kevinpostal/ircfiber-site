<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchPastebinsOffset, updatePastebin, deletePastebin, pastebinRawUrl, type PasteEntry } from '../stores/api';
  import { ACE_MODES, aceModeLabel } from '../lib/aceModes';

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
      const updated = await updatePastebin(entry.id, { name: editName, syntax: editSyntax });
      entry.name = updated.name;
      entry.syntax = updated.syntax;
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
                  <input class="input nameInput" name="name" placeholder="Name" bind:value={editName} />
                  <select name="aceMode" bind:value={editSyntax}>
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
          <div class="editor" class:noGutter={gutterHidden[entry.id]} style="height: {editorHeight(entry)}px;">
            <div class="editorScroll">
              {#if !gutterHidden[entry.id]}
                <div class="gutter" aria-hidden="true">
                  {#each { length: entry.lines } as _, i}
                    <div class="gutterCell">{i + 1}</div>
                  {/each}
                </div>
              {/if}
              <pre class="code">{entry.body}</pre>
            </div>
          </div>
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
