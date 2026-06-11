<script lang="ts">
  import { collectDroppedFiles } from '../lib/upload';
  import { ircState } from '../stores/ircStore.svelte';

  interface Props {
    onFilesDropped: (result: { accepted: File[]; truncated: boolean }, opts: { immediate: boolean }) => void;
  }
  let { onFilesDropped }: Props = $props();

  let visible = $state(false);
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;

  const targetName = $derived(ircState.activeBuffer.bufferName || 'this buffer');

  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  }

  function onDragOver(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    visible = true;
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => { visible = false; }, 1000);
  }

  function onDragLeave(e: DragEvent): void {
    if (!hasFiles(e)) return;
    if (e.pageX <= 0 || e.pageX >= window.innerWidth || e.pageY <= 0 || e.pageY >= window.innerHeight) {
      visible = false;
    }
  }

  async function onDrop(e: DragEvent): Promise<void> {
    if (!e.dataTransfer) return;
    e.preventDefault();
    visible = false;
    if (fadeTimer) clearTimeout(fadeTimer);
    const immediate = e.shiftKey || e.altKey;
    const result = await collectDroppedFiles(e.dataTransfer);
    if (result.accepted.length > 0) onFilesDropped(result, { immediate });
  }

  $effect(() => {
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  });
</script>

{#if visible}
  <div id="dropTargetContainer" class="visible" role="presentation">
    <div class="dropTarget">
      <i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i>
      <div class="dropHeading">Drop to upload to {targetName}</div>
      <div class="dropHint">Hold Shift to send immediately</div>
    </div>
  </div>
{/if}
