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

  // Smart stock thumbnail: detect file kind from ext + mime (IRCCloud parity)
  type StockKind = 'pdf' | 'archive' | 'video' | 'audio' | 'document' | 'spreadsheet' | 'presentation' | 'generic';
  interface StockMeta { kind: StockKind; ext: string; label: string; icon: string; bg: string; fg: string; }

  function getStockMeta(filename: string, type?: string): StockMeta {
    const lower = filename.toLowerCase();
    const dot = lower.lastIndexOf('.');
    const ext = dot > 0 && dot < lower.length - 1 ? lower.slice(dot + 1).toLowerCase() : '';
    const mime = (type || '').toLowerCase();
    // pdf
    if (ext === 'pdf' || mime === 'application/pdf') return { kind: 'pdf', ext: 'PDF', label: 'PDF Document', icon: 'fa-file-pdf', bg: '#dc2626', fg: '#fff' };
    // archive
    if (['zip','tar','gz','tgz','bz2','xz','7z','rar','iso','dmg','pkg','zst'].includes(ext) || mime.includes('zip') || mime.includes('tar') || mime.includes('gzip') || mime.includes('compressed') || mime === 'application/x-7z-compressed' || mime === 'application/vnd.rar')
      return { kind: 'archive', ext: ext.toUpperCase() || 'ZIP', label: 'Archive', icon: 'fa-file-zipper', bg: '#d97706', fg: '#fff' };
    // video
    if (mime.startsWith('video/') || ['mp4','mov','webm','avi','mkv','m4v','flv','wmv','3gp','mpg','mpeg'].includes(ext))
      return { kind: 'video', ext: ext.toUpperCase() || 'VID', label: 'Video', icon: 'fa-file-video', bg: '#7c3aed', fg: '#fff' };
    // audio
    if (mime.startsWith('audio/') || ['mp3','wav','flac','ogg','oga','aac','m4a','wma','opus','mid','midi','aiff'].includes(ext))
      return { kind: 'audio', ext: ext.toUpperCase() || 'AUD', label: 'Audio', icon: 'fa-file-audio', bg: '#059669', fg: '#fff' };
    // document
    if (['doc','docx','odt','rtf','pages'].includes(ext) || mime === 'application/msword' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      return { kind: 'document', ext: ext.toUpperCase(), label: 'Document', icon: 'fa-file-word', bg: '#2563eb', fg: '#fff' };
    // spreadsheet
    if (['xls','xlsx','ods','csv'].includes(ext) || mime.includes('spreadsheet') || mime === 'text/csv')
      return { kind: 'spreadsheet', ext: ext.toUpperCase(), label: 'Spreadsheet', icon: 'fa-file-excel', bg: '#16a34a', fg: '#fff' };
    // presentation
    if (['ppt','pptx','odp','key'].includes(ext) || mime.includes('presentation'))
      return { kind: 'presentation', ext: ext.toUpperCase(), label: 'Presentation', icon: 'fa-file-powerpoint', bg: '#ea580c', fg: '#fff' };
    return { kind: 'generic', ext: ext ? ext.toUpperCase() : 'FILE', label: mime ? mime.split('/').pop()?.toUpperCase() || 'File' : 'File', icon: 'fa-file', bg: '#4b5563', fg: '#fff' };
  }

  let imgLoadFailed = $state(false);

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

  // reset image error when switching files
  $effect(() => {
    // track previewUrl as trigger
    const d = uploadState.dialog;
    const url = d?.uploads[0]?.previewUrl;
    if (url) imgLoadFailed = false;
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
            {:else if isImg && !imgLoadFailed}
              <span class="previewWrapper">
                <span class="localPreview localImagePreview">
                  <img class="unknownFilePreview" src={u.previewUrl} alt={u.filename} onerror={() => imgLoadFailed = true} />
                </span>
              </span>
            {:else}
              {@const meta = getStockMeta(u.filename, (u.file as File)?.type)}
              <span class="previewWrapper">
                <span class="localPreview stockPreview stockPreview--{meta.kind}">
                  <span class="stockThumb" style="--stock-bg: {meta.bg}; --stock-fg: {meta.fg}">
                    <i class="fa-solid {meta.icon} stockThumbIcon" aria-hidden="true"></i>
                    <span class="stockThumbExt">{meta.ext}</span>
                  </span>
                  <span class="stockThumbName" title={u.filename}>{u.filename}</span>
                  <span class="stockThumbMeta">{meta.label} • {formatSize(u.size)}</span>
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
<style>
  .stockPreview {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 18px 16px 14px;
    background: #0d1117;
    border: 1px solid #2c2f35;
    border-radius: 8px;
    min-height: 160px;
    justify-content: center;
  }
  .stockThumb {
    position: relative;
    width: 88px;
    height: 88px;
    border-radius: 10px;
    background: var(--stock-bg);
    color: var(--stock-fg);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(0,0,0,0.35);
  }
  .stockThumbIcon {
    font-size: 38px;
    line-height: 1;
    filter: drop-shadow(0 1px 1px rgba(0,0,0,0.2));
  }
  .stockThumbExt {
    position: absolute;
    bottom: -6px;
    right: -6px;
    background: #1a1d21;
    color: #d1d5db;
    border: 1px solid #2c2f35;
    font-family: 'Hack', monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 2px 5px;
    border-radius: 4px;
    line-height: 1;
    max-width: 52px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stockThumbName {
    font-size: 13px;
    font-weight: 600;
    color: #d1d5db;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 8px;
    box-sizing: border-box;
  }
  .stockThumbMeta {
    font-size: 12px;
    color: #8b949e;
  }
  .stockPreview--pdf .stockThumb { background: #dc2626; }
  .stockPreview--archive .stockThumb { background: #d97706; }
  .stockPreview--video .stockThumb { background: #7c3aed; }
  .stockPreview--audio .stockThumb { background: #059669; }
  .stockPreview--document .stockThumb { background: #2563eb; }
  .stockPreview--spreadsheet .stockThumb { background: #16a34a; }
  .stockPreview--presentation .stockThumb { background: #ea580c; }
  .stockPreview--generic .stockThumb { background: #4b5563; }
</style>
