<script lang="ts">
  import { uploadState } from '../stores/uploadStore.svelte';
  import { ircState } from '../stores/ircStore.svelte';
  import Img2IrcDialog from './Img2IrcDialog.svelte';

  interface Props {
    onConfirm: (data: { filename?: string; message: string }) => void;
    onCancel: () => void;
  }
  let { onConfirm, onCancel }: Props = $props();

  let filenameInput = $state('');
  let messageInput = $state('');
  let showIrcConvert = $state(false);

  function isImageFile(filename: string, type?: string): boolean {
    if (type && /^image\//i.test(type)) return true;
    return /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(filename);
  }

  // Text preview state — loaded via File.text() once per file so we don't
  // re-fetch a blob: URL on every render (Svelte {#await fetch(...)} re-creates
  // the promise and flashes). $effect tracks the active file identity.
  let textPreview = $state<string | null>(null);
  let textPreviewLoading = $state(false);
  let textPreviewError = $state(false);

  function isTextPreviewFile(filename: string, type?: string): boolean {
    if (type && /^text\//i.test(type)) return true;
    const lower = filename.toLowerCase();
    if (lower === 'dockerfile' || lower === 'makefile' || lower === '.env') return true;
    return /\.(txt|text|md|markdown|mdown|mkd|json|json5|js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyw|pyi|rb|gemspec|rake|java|c|h|cpp|hpp|cc|cxx|hh|go|rs|php|phtml|sh|bash|zsh|ksh|fish|html|htm|xhtml|css|scss|sass|less|stylus|yaml|yml|xml|svg|toml|sql|pgsql|mysql|graphql|gql|dockerfile|containerfile|makefile|mk|ini|conf|cfg|properties|lua|perl|pl|pm|swift|kotlin|kt|kts|scala|clj|ex|exs|dart|r|rmd|jl|hs|erl|elm|vue|svelte|astro|tf|hcl|nix|nginx|apache|htaccess|bat|cmd|ps1|tex|diff|patch|csv|prql|proto|zig|nim|coffee|jade|pug|hbs|liquid)$/i.test(lower) || /\.(log|csv)$/i.test(lower);
  }

  $effect(() => {
    const d = uploadState.dialog;
    const u = d?.uploads.length === 1 ? d.uploads[0] : null;
    if (!d || d.mode !== 'single' || !u || !isTextPreviewFile(u.filename, (u.file as File)?.type)) {
      textPreview = null;
      textPreviewError = false;
      textPreviewLoading = false;
      return;
    }
    const file = u.file as File | undefined;
    if (!file) {
      textPreview = null;
      textPreviewError = true;
      textPreviewLoading = false;
      return;
    }
    let cancelled = false;
    textPreview = null;
    textPreviewError = false;
    textPreviewLoading = true;
    file.text().then((t) => {
      if (cancelled) return;
      textPreview = t.length > 4000 ? t.slice(0, 4000) + '…' : t;
      textPreviewLoading = false;
    }).catch(() => {
      if (cancelled) return;
      textPreviewError = true;
      textPreviewLoading = false;
    });
    return () => { cancelled = true; };
  });

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
    if (e.key === 'Escape') {
      if (showIrcConvert) showIrcConvert = false;
      else onCancel();
    }
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

  function handleConvertToIrc(): void {
    showIrcConvert = true;
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
        {@const isText = u ? isTextPreviewFile(u.filename, (u.file as File)?.type) : false}
        {@const isImg = u ? isImageFile(u.filename, (u.file as File)?.type) : false}
        <div class="single" style="">
          {#if u?.previewUrl}
            {#if isText}
              <span class="previewWrapper">
                <span class="localPreview localTextPreview" style="display:block; max-height:min(320px, 40vh); overflow:auto; background:#1e1e1e; color:#e6e6e6; padding:10px; border-radius:3px; font-family: 'Hack', monospace; font-size:12px; white-space: pre-wrap; overflow-wrap: break-word;">
                  {#if textPreviewLoading}
                    <span>Loading preview…</span>
                  {:else if textPreviewError}
                    <span>Preview unavailable</span>
                  {:else if textPreview !== null}
                    <span style="white-space: pre-wrap; overflow-wrap: break-word;">{textPreview}</span>
                  {/if}
                </span>
              </span>
            {:else}
              <span class="previewWrapper">
                <span class="localPreview localImagePreview">
                  <img class="unknownFilePreview" src={u.previewUrl} alt={u.filename} />
                </span>
              </span>
            {/if}
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

          <p class="explanation info">{formatSize(u?.size ?? 0)} • {u?.filename.split('.').pop() ?? ''} {#if isText}• text{/if}{#if isImg}• image{/if}</p>
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
        {#if (() => { const u = activeUpload(); return u ? isImageFile(u.filename, (u.file as File)?.type) : false; })()}
          <button type="button" class="action convertToIrc" onclick={handleConvertToIrc} title="Convert image to mIRC color codes and send as text art"><span>Convert to IRC</span></button>
        {/if}
        <button type="button" class="sendAsText" style="display: none;"><span>Send as text</span></button>
        <button type="button" class="close mainClose" onclick={onCancel}><span>Cancel</span></button>
      </p>
    </form>
  </div>
{/if}

{#if showIrcConvert && uploadState.dialog}
  {@const u = activeUpload()}
  {#if u?.file}
    <Img2IrcDialog
      file={u.file as File}
      filename={u.filename}
      onClose={() => { showIrcConvert = false; onCancel(); }}
      onBack={() => { showIrcConvert = false; }}
    />
  {/if}
{/if}
