<script lang="ts">
  import { uploadState, dismissUploadProgress, type ActiveUpload } from '../stores/uploadStore.svelte';
  import { sizeToString } from '../lib/upload';

  const AUTO_DISMISS_MS = 1200;

  let dlg = $derived(uploadState.progressDialog);
  let rows = $derived<ActiveUpload[]>(
    dlg ? dlg.ids.flatMap((id) => {
      const u = uploadState.active.find((a) => a.id === id);
      return u ? [u] : [];
    }) : [],
  );
  let convertToGif = $derived(dlg?.convertToGif ?? false);
  let anythingRunning = $derived(
    rows.some((u) => u.status === 'uploading' || u.status === 'finalizing' || u.status === 'converting'),
  );

  function stageText(u: ActiveUpload): string {
    if (u.status === 'error') return u.error || 'Failed';
    if (u.status === 'uploading') return `Uploading… ${Math.round(u.progress)}%`;
    if (u.status === 'finalizing') return 'Finishing upload…';
    if (u.status === 'converting') {
      const g = u.gif;
      if (!g || g.phase === 'palette') return 'Analyzing colors…';
      if (g.durationMs === 0) return 'Converting…';
      return `Encoding GIF… ${Math.round(g.percent)}%`;
    }
    if (u.status === 'done') return 'Done';
    if (u.status === 'cancelled') return 'Cancelled';
    return '';
  }

  function etaSuffix(u: ActiveUpload): string {
    const ms = u.status === 'converting' ? (u.gif?.etaMs ?? 0) : 0;
    return ms > 0 ? `~${Math.round(ms / 1000)}s left` : '';
  }

  /** No measurable percent: palette pass, or an encode whose source
   *  duration ffprobe could not determine (durationMs === 0). */
  function isIndeterminate(u: ActiveUpload): boolean {
    if (u.status !== 'converting') return false;
    const g = u.gif;
    return !g || g.phase === 'palette' || g.durationMs === 0;
  }

  function barPercent(u: ActiveUpload): number {
    if (u.status === 'converting' && u.gif && u.gif.phase === 'encode' && u.gif.durationMs > 0) {
      return Math.max(0, Math.min(100, Math.round(u.gif.percent)));
    }
    return Math.max(0, Math.min(100, Math.round(u.progress)));
  }

  function hide(): void {
    // Hide only: keep the rows so the UploadMenu ring keeps their state.
    uploadState.progressDialog = null;
  }

  function close(): void {
    dismissUploadProgress();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !uploadState.progressDialog) return;
    if (anythingRunning) hide();
    else close();
  }

  $effect(() => {
    if (!uploadState.progressDialog) return;
    if (rows.length === 0) {
      // Every row was removed elsewhere (e.g. the 1500 ms cleanup timer).
      uploadState.progressDialog = null;
      return;
    }
    const failed = rows.some((u) => u.status === 'error');
    if (!anythingRunning && !failed) {
      const t = setTimeout(() => dismissUploadProgress(), AUTO_DISMISS_MS);
      return () => clearTimeout(t);
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if uploadState.progressDialog !== null}
  <div id="uploadProgressContainer" class="uploadDialog" style="display: block;" role="dialog" aria-label={convertToGif ? 'Making a GIF' : 'Uploading files'}>
    <h1 class="heading" tabindex="0">
      {convertToGif ? 'Making a GIF' : 'Uploading files'}
    </h1>

    <ul class="progressList">
      {#each rows as u (u.id)}
        <li class="progressRow">
          <div class="progressMeta">
            <span class="progressName" title={u.filename}>{u.filename}</span>
            <span class="explanation info progressSize">{sizeToString(u.size)}</span>
          </div>
          {#if isIndeterminate(u)}
            <div class="progressBar indeterminate" role="progressbar">
              <div class="progressFillIndeterminate"></div>
            </div>
          {:else}
            <div class="progressBar" role="progressbar" aria-valuenow={barPercent(u)} aria-valuemin="0" aria-valuemax="100">
              <div class="progressFill" style="width: {barPercent(u)}%"></div>
            </div>
          {/if}
          <div class="progressStage">
            <span>{stageText(u)}</span>
            {#if etaSuffix(u)}
              <span class="progressEta">{etaSuffix(u)}</span>
            {/if}
          </div>
          {#if u.status === 'error' && convertToGif}
            <p class="explanation info">Posted the original file instead.</p>
          {/if}
        </li>
      {/each}
    </ul>

    <p class="buttons">
      {#if anythingRunning}
        <button type="button" class="close mainClose" onclick={hide}><span>Hide</span></button>
      {:else}
        <button type="button" class="close mainClose" onclick={close}><span>Close</span></button>
      {/if}
    </p>
  </div>
{/if}

<style>
  .progressList {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .progressRow {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .progressMeta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .progressName {
    font-size: 13px;
    font-weight: 600;
    color: #d1d5db;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .progressSize {
    flex-shrink: 0;
  }
  .progressBar {
    position: relative;
    height: 8px;
    border-radius: 4px;
    background: #21262d;
    overflow: hidden;
  }
  .progressFill {
    height: 100%;
    border-radius: 4px;
    background: #238636;
    transition: width 0.2s linear;
  }
  .progressBar.indeterminate {
    background: #21262d;
  }
  .progressFillIndeterminate {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 40%;
    border-radius: 4px;
    background: #58a6ff;
    animation: uploadProgressSlide 1.2s ease-in-out infinite alternate;
  }
  @keyframes uploadProgressSlide {
    from { left: 0; }
    to { left: 60%; }
  }
  .progressStage {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: 13px;
    color: #d1d5db;
  }
  .progressEta {
    color: #8b949e;
    font-size: 12px;
  }
</style>
