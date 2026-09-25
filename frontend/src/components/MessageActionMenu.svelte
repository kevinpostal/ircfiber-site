<script lang="ts">
  // Per-message actions for one row: the IRCv3 set the engine negotiates
  // (quick reactions, Reply, Copy text, Edit via draft/edit-message,
  // Delete via draft/message-redaction). Desktop renders a positioned
  // `.contextMenu` at the row's More button / right-click point; touch
  // renders the same items as a bottom sheet. Mounted once in App, keyed
  // on the row's msgid, so per-row state (confirmDelete) never leaks.
  import { onMount, onDestroy } from 'svelte';
  import {
    ircState, closeMessageActions, toggleReaction, setReplyTarget, setReactTarget,
    requestEdit, QUICK_REACTIONS, type MessageActionsTarget,
  } from '../stores/ircStore.svelte';
  import { sendRaw } from '../stores/wsConnection.svelte.ts';
  import { globalPrefs } from '../stores/preferences.svelte';
  import { stripPrefix } from '../lib/utils';
  import { positionMenu } from '../lib/menuPosition';
  import { clientTagFeatures } from '../lib/clientTags';

  interface Props {
    target: MessageActionsTarget;
  }
  let { target }: Props = $props();

  let menuEl = $state<HTMLElement | null>(null);
  let confirmDelete = $state(false);

  const net = $derived(ircState.networks.find(n => n.networkId === target.networkId));
  const myNick = $derived(net?.currentNick ?? '');
  const isOwn = $derived(!!target.msg.nick && stripPrefix(target.msg.nick).toLowerCase() === myNick.toLowerCase());
  // Edits go out as a normal message carrying a `+draft/edit` client tag
  // naming the row's msgid, so any own row with a msgid is editable
  // (not just the last sent one). Redacted rows can never be edited.
  const canEdit = $derived(
    isOwn && !!target.msg.msgid && !target.msg.redacted
    && globalPrefs.featureFlags.editMessage.enabled
    && !!net?.capabilities.has('draft/edit-message'),
  );
  // Every row, not just own: the redaction spec has clients attempt any
  // deletion and the server answer FAIL REDACT REDACT_FORBIDDEN.
  const canDelete = $derived(!!net?.capabilities.has('draft/message-redaction'));
  const tagFeatures = $derived(clientTagFeatures(net));
  const ownReactions = $derived(new Set(
    Object.entries(target.msg.reactions ?? {})
      .filter(([, nicks]) => nicks.some(n => n.toLowerCase() === myNick.toLowerCase()))
      .map(([e]) => e),
  ));

  function react(emoji: string): void {
    toggleReaction(target.networkId, target.bufferName, target.msg, emoji);
    closeMessageActions();
  }
  function openPicker(): void {
    if (target.msg.msgid) setReactTarget(target.networkId, target.bufferName, target.msg.msgid);
    closeMessageActions();
  }
  function reply(): void {
    setReplyTarget(target.networkId, target.bufferName, target.msg);
    closeMessageActions();
  }
  function copyText(): void {
    const text = target.msg.text ?? '';
    const write = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('clipboard unavailable'));
    write.catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
    closeMessageActions();
  }
  function edit(): void {
    if (!target.msg.msgid) return;
    requestEdit({
      networkId: target.networkId, bufferName: target.bufferName,
      msgid: target.msg.msgid, body: target.msg.text ?? '',
    });
    closeMessageActions();
  }
  /** Two clicks: the label flips to "Confirm delete" first. No reason is
   *  sent (the spec forbids a default one); the tombstone comes from the
   *  server's relayed REDACT (applyRedaction), nothing optimistic. */
  function del(): void {
    if (!confirmDelete) { confirmDelete = true; return; }
    sendRaw(target.networkId, `REDACT ${target.bufferName} ${target.msg.msgid}`);
    closeMessageActions();
  }

  function clickOutside(e: MouseEvent): void {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMessageActions();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') closeMessageActions();
  }
  // The log scrolling under an open menu would leave it floating over the
  // wrong row; scroll does not bubble, so listen in the capture phase.
  function onScroll(): void {
    closeMessageActions();
  }
  onMount(() => {
    setTimeout(() => document.addEventListener('click', clickOutside), 0);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, { capture: true });
  });
  onDestroy(() => {
    document.removeEventListener('click', clickOutside);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('scroll', onScroll, { capture: true });
  });

  // Keep the row's hover actions visible while its menu is open.
  $effect(() => {
    const el = target.rowEl;
    if (!el) return;
    el.classList.add('actionsOpen');
    return () => el.classList.remove('actionsOpen');
  });

  $effect(() => {
    if (menuEl && !target.sheet) positionMenu(menuEl, target.x, target.y);
  });
</script>

{#snippet iconReact()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11v1a10 10 0 1 1-9-10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/><path d="M16 5h6"/><path d="M19 2v6"/></svg>{/snippet}

{#snippet items()}
  {#if tagFeatures.react}
  <div class="reactRow">
    {#each QUICK_REACTIONS as emoji (emoji)}
      <button type="button" class="quickReaction" class:own={ownReactions.has(emoji)} aria-label="React {emoji}" aria-pressed={ownReactions.has(emoji)} onclick={() => react(emoji)}>{emoji}</button>
    {/each}
    <button type="button" class="quickReaction more" title="More reactions" aria-label="More reactions" onclick={openPicker}>{@render iconReact()}</button>
  </div>
  <hr>
  {/if}
  <ul class="actions">
    {#if tagFeatures.reply}<li><button type="button" class="contextMenu__item reply" role="menuitem" onclick={reply}>Reply</button></li>{/if}
    <li><button type="button" class="contextMenu__item copy" role="menuitem" onclick={copyText}>Copy text</button></li>
    {#if canEdit}<li><button type="button" class="contextMenu__item edit" role="menuitem" onclick={edit}>Edit</button></li>{/if}
    {#if canDelete}<li><button type="button" class="contextMenu__item delete danger" role="menuitem" onclick={del}>{confirmDelete ? 'Confirm delete' : 'Delete…'}</button></li>{/if}
  </ul>
{/snippet}

{#if target.sheet}
  <div class="messageActionSheet" role="dialog" aria-label="Message actions">
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="messageActionSheet__scrim" onclick={closeMessageActions}></div>
    <div class="messageActionSheet__panel" bind:this={menuEl}>
      <div class="messageActionSheet__grab"></div>
      {@render items()}
    </div>
  </div>
{:else}
  <div class="contextMenu messageActionMenu" bind:this={menuEl} role="menu" aria-label="Message actions">
    <div class="contextMenu__wrap">
      {@render items()}
    </div>
  </div>
{/if}
