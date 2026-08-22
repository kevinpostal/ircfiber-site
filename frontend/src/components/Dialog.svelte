<script lang="ts">
  import { untrack } from 'svelte';
  interface Props {
    open: boolean;
    onClose: () => void;
    label?: string;
    centered?: boolean;
    class?: string;
    hideClose?: boolean;
    children?: import('svelte').Snippet;
  }
  let { open, onClose, label, centered = false, class: klass = '', hideClose = false, children }: Props = $props();
  let dialogEl: HTMLDialogElement | null = $state(null);
  // Svelte 5: effect that both reads and writes the same signal loops
  // (effect_update_depth_exceeded). showModal/close mutate the native
  // <dialog>.open but must not re-trigger the effect via the `open` prop
  // that the parent writes in onClose. Use untrack for the DOM mutation
  // and only depend on `open` + `dialogEl` intentionally.
  $effect(() => {
    const shouldOpen = open;
    const el = dialogEl;
    if (!el) return;
    if (!shouldOpen) return;
    untrack(() => {
      if (!el.open) {
        try { el.showModal(); } catch {}
      }
    });
  });
  function handleClose(){ onClose(); }
  function handleBackdrop(e: MouseEvent){ if(e.target===dialogEl) onClose(); }
</script>
{#if open}
<dialog
  bind:this={dialogEl}
  closedby="any"
  class={klass + (centered ? ' centered' : '')}
  role="dialog"
  aria-modal="true"
  aria-label={label}
  onclick={handleBackdrop}
  onclose={handleClose}
  oncancel={(e)=>{ e.preventDefault(); handleClose(); }}
>
  {#if !hideClose}
    <form method="dialog"><button class="overlay-close" aria-label="Close" type="submit" onclick={onClose}>&times;</button></form>
  {/if}
  {@render children?.()}
</dialog>
{/if}
<style>
  dialog{border:none;padding:0;background:var(--surface,#1a1d21);max-width:900px;color:inherit}
  dialog::backdrop{background:rgba(0,0,0,0.4)}
  dialog.overlay-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100;background:#1a1d21;border:1px solid #2c2f35;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);min-width:320px;width:75%;max-width:900px;max-height:85vh;overflow:auto}
  .overlay-close{position:absolute;top:4px;right:4px;background:transparent;border:none;color:#8b949e;font-size:20px;line-height:1;cursor:pointer;padding:0 6px;z-index:2}
  .overlay-close:hover{color:#fff}
  dialog:not([open]){display:none}
  dialog[open]{display:block}
</style>
