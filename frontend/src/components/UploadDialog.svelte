<script lang="ts">
  import { uploadState } from '../stores/uploadStore.svelte';
  import { ircState } from '../stores/ircStore.svelte';

  interface Props {
    onConfirm: (data: { filename?: string; message: string }) => void;
    onCancel: () => void;
  }
  let { onConfirm, onCancel }: Props = $props();

  let filenameInput = $state('');
  let messageInput = $state('');

  $effect(() => {
    const d = uploadState.dialog;
    if (!d) return;
    messageInput = d.message;
    if (d.uploads.length === 1) filenameInput = d.uploads[0].filename;
  });

  function handleSubmit(e: Event): void {
    e.preventDefault();
    onConfirm({ filename: filenameInput || undefined, message: messageInput });
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onCancel();
  }

  function activeUpload() {
    const d = uploadState.dialog;
    return d?.uploads.length === 1 ? d.uploads[0] : null;
  }

  function isBatch() {
    const d = uploadState.dialog;
    return !!d && d.uploads.length > 1;
  }

  function formatSize(size: number): string {
    if (size > 1_000_000) return (size / 1_000_000).toFixed(2) + 'MB';
    if (size > 1_000) return (size / 1_000).toFixed(0) + 'KB';
    return size + 'B';
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if uploadState.dialog}
  <div id="fileUploadContainer" class="uploadDialog" style="display: block;">
    <h1 class="heading" tabindex="0">
      Upload a file to {ircState.activeBuffer.bufferName || 'this buffer'}
    </h1>

    <form onsubmit={handleSubmit} id="fileUploadForm">
      {#if isBatch()}
        <div class="batch" style="display: none;">
          <div class="treeContainer"></div>
          <p class="userInfo maxUploadBatchInfo" style="display: none;">
            You can only upload <span class="maxUploadBatch">{uploadState.dialog!.uploads.length}</span> files at once
          </p>
        </div>
      {:else}
        {@const u = activeUpload()}
        <div class="single" style="">
          {#if u?.previewUrl}
            <span class="previewWrapper">
              <span class="localPreview localImagePreview">
                <img class="unknownFilePreview" src={u.previewUrl} alt={u.filename} />
              </span>
            </span>
          {/if}

          <p class="form">
            <label for="uploadPreviewName">Choose a file name</label><br>
            <input
              name="name"
              class="input"
              id="uploadPreviewName"
              bind:value={filenameInput}
              placeholder={u?.filename ?? ''}
            />
          </p>

          <p class="explanation info">{formatSize(u?.size ?? 0)} • {u?.filename.split('.').pop() ?? ''}</p>
        </div>
      {/if}

      <p class="form">
        <label for="uploadPreviewMessage">Add a message <span class="explanation">optional</span></label><br>
        <input
          name="message"
          class="input"
          id="uploadPreviewMessage"
          bind:value={messageInput}
        />
      </p>

      <div class="uploadConfirmExtra">
        <p class="dropped" style="display: none;">You can upload files with drag and drop too!</p>
        <p style="">Hold <kbd>Alt <span>or</span> Shift</kbd> when dropping to upload without this prompt</p>
      </div>

      <p class="buttons">
        <button type="submit" class="action confirm"><span>Upload</span></button>
        <button type="button" class="sendAsText" style="display: none;"><span>Send as text</span></button>
        <button type="button" class="close mainClose" onclick={onCancel}><span>Cancel</span></button>
      </p>
    </form>
  </div>
{/if}
