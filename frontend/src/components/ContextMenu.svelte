<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';
  import { onMount, onDestroy } from 'svelte';

  let menuEl: HTMLDivElement;

  function handleClickOutside(e: MouseEvent): void {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      ircState.contextMenu.visible = false;
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside);
  });
</script>

{#if ircState.contextMenu.visible}
  <div class="contextMenu" style="left: {ircState.contextMenu.x}px; top: {ircState.contextMenu.y}px;" bind:this={menuEl}>
    <div class="contextMenu__wrap">
      <ul class="actions">
        {#each ircState.contextMenu.actions as action}
          {#if action.separator}
            <li class="contextMenu__separator"></li>
          {:else}
            <li>
              <button class="contextMenu__item {action.className || ''}"
                      type="button" onclick={action.handler}>
                {action.label}
              </button>
            </li>
          {/if}
        {/each}
      </ul>
    </div>
  </div>
{/if}
