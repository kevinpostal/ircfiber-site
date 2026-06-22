<script lang="ts">
  import { uploadState, type ActiveUpload } from '../stores/uploadStore.svelte';
  import { startUploads } from '../stores/uploadFlow.svelte';
  import { ircState } from '../stores/ircStore.svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (typeof document === 'undefined') return;
    const handler = (e: MouseEvent) => {
      if (menuEl && !menuEl.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  });

  function handleUploadFile(): void {
    fileInput?.click();
  }

  function handleNewPaste(): void {
    onClose();
  }

  function handleShowFiles(): void {
    uploadState.panelOpen = true;
    onClose();
  }

  function handleShowPastes(): void {
    uploadState.pastebinPanelOpen = true;
    onClose();
  }

  function onFilePicked(e: Event): void {
    const files = (e.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;
    startUploads(Array.from(files), {
      networkId: ircState.activeBuffer.networkId ?? '',
      buffer: ircState.activeBuffer.bufferName ?? '',
    });
    onClose();
    (e.target as HTMLInputElement).value = '';
  }

  function statusText(u: ActiveUpload): string {
    if (u.status === 'uploading') return `${u.progress}%`;
    if (u.status === 'finalizing') return 'Processing…';
    if (u.status === 'done') return 'Done';
    if (u.status === 'error') return u.error || 'Failed';
    if (u.status === 'cancelled') return 'Cancelled';
    return '';
  }
</script>

<div bind:this={menuEl} class="uploadMenu contextMenu bufferContextMenu">
  <div class="contextMenu__wrap">
    {#if uploadState.active.length > 0}
      <ul id="uploadProgressBars">
        {#each uploadState.active as u (u.id)}
          <li>
            <span class="uploadName" title={u.filename}>{u.filename}</span>
            <span class="uploadStatus">{statusText(u)}</span>
            <div class="uploadProgressTrack">
              <div class="uploadProgressFill" style="width: {u.progress}%"></div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <ul class="actions">
      <li class="uploadFile">
        <button class="contextMenu__item uploadFile" onclick={handleUploadFile}>
          Upload a file…
        </button>
      </li>
      <li>
        <button class="contextMenu__item newPaste" onclick={handleNewPaste}>
          Post a text snippet…
        </button>
      </li>
      <li>
        <button class="contextMenu__item showFiles" onclick={handleShowFiles}>
          File uploads
        </button>
      </li>
      <li>
        <button class="contextMenu__item showPastes" onclick={handleShowPastes}>
          Text snippets
        </button>
      </li>
    </ul>
  </div>
  <input
    type="file"
    bind:this={fileInput}
    class="hidden"
    accept="image/*"
    multiple
    onchange={onFilePicked}
    aria-hidden="true"
    tabindex="-1"
  />
</div>

<style>
  .hidden { display: none; }

  :global(.uploadMenu) { min-width: 220px; }
  :global(.uploadMenu #uploadProgressBars) {
    list-style: none;
    margin: 0;
    padding: 5px 12px;
    border-bottom: 1px solid #2c2f35;
  }
  :global(.uploadMenu #uploadProgressBars li) {
    padding: 4px 0;
    font-size: 12px;
    color: #d1d5db;
  }
  :global(.uploadMenu .uploadName) {
    display: inline-block;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
  }
  :global(.uploadMenu .uploadStatus) {
    float: right;
    font-size: 11px;
    color: #8b949e;
  }
  :global(.uploadMenu .uploadProgressTrack) {
    height: 4px;
    background: #2c2f35;
    margin-top: 3px;
    overflow: hidden;
    border-radius: 2px;
  }
  :global(.uploadMenu .uploadProgressFill) {
    height: 100%;
    background: #58a6ff;
    transition: width 0.2s;
    border-radius: 2px;
  }
  :global(.uploadMenu .actions) {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  :global(.uploadMenu .actions li) {
    margin: 0;
  }
</style>
