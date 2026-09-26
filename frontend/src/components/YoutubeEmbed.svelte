<script lang="ts">
  import { onDestroy } from 'svelte';
  import { youtubeEmbedUrl } from '../lib/youtube';
  import {
    attachYoutubeBridge,
    YT_STATE_PLAYING,
    YT_STATE_BUFFERING,
    type YtPlayerInfo,
  } from '../lib/youtubePlayerBridge';
  import { mediaDock, dockVideo, closeDock, minimizeDock } from '../stores/mediaDock.svelte';
  import { ircState } from '../stores/ircStore.svelte';

  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  let closed = $state(false);
  let iframeEl = $state<HTMLIFrameElement | undefined>();
  let resumeAt = $state(0);
  let autoplay = $state(false);
  // Last info the embed reported. Read at teardown, when the iframe DOM is
  // already gone, so it cannot be reactive-derived from the element.
  let lastInfo: YtPlayerInfo = {};

  // The buffer this row belongs to is the one active at mount. By the time
  // onDestroy runs during a switch, activeBuffer already points at the new
  // buffer, so it must be captured here.
  const originBuffer =
    ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName
      ? { networkId: ircState.activeBuffer.networkId, bufferName: ircState.activeBuffer.bufferName }
      : null;

  const docked = $derived(mediaDock.video?.videoId === id);
  const src = $derived(youtubeEmbedUrl(id, { start: resumeAt, autoplay }));

  $effect(() => {
    if (!iframeEl) return;
    return attachYoutubeBridge(iframeEl, (info) => {
      lastInfo = { ...lastInfo, ...info };
    });
  });

  /** Hand this row's video to the mini player from its last reported position. */
  function dockHere(): void {
    dockVideo({
      videoId: id,
      startSeconds: Math.floor(lastInfo.currentTime ?? 0),
      origin: originBuffer,
    });
  }

  // Unmount (channel switch or windowing trim) while playing → keep the
  // video alive in the mini player from its last reported position.
  onDestroy(() => {
    if (closed || docked) return;
    const st = lastInfo.playerState;
    if (st !== YT_STATE_PLAYING && st !== YT_STATE_BUFFERING) return;
    dockHere();
  });

  // stopPropagation on every control keeps the MessageRow click/selection
  // handlers out of it, like the reaction buttons.
  function onClose(e: MouseEvent): void {
    e.stopPropagation();
    closed = true;
  }

  // Explicit pop-out works for paused / never-started videos too (start 0
  // when nothing has been reported yet). The dock URL carries autoplay=1,
  // so a paused video resumes there; intended.
  function popOut(e: MouseEvent): void {
    e.stopPropagation();
    dockHere();
  }

  /** Straight to the taskbar chip: the dock mounts already hidden, playback continues there. */
  function minimize(e: MouseEvent): void {
    e.stopPropagation();
    dockHere();
    minimizeDock();
  }

  function returnHere(): void {
    // Set src inputs before closing the dock so the iframe mounts with the
    // resume position on the same flush.
    resumeAt = Math.floor(mediaDock.video?.positionSeconds ?? 0);
    autoplay = true;
    closeDock();
  }
</script>

{#if !closed}
  <span class="directEmbedWrap videoWrap" data-youtube-id={id}>
    {#if docked}
      <span class="youtubeDocked" style="width: 416px; height: 234px; max-width: 416px">
        <span>Playing in mini player</span>
        <button type="button" class="youtubeDockedReturn" onclick={returnHere}>Bring back here</button>
      </span>
    {:else}
      <iframe
        bind:this={iframeEl}
        type="text/html"
        allowfullscreen={true}
        mozallowfullscreen
        webkitallowfullscreen
        sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-presentation"
        scrolling="no"
        class="iframeEmbed video"
        width="416"
        height="234"
        src={src}
        title="YouTube video {id}"
        style="width: 416px; height: 234px; max-width: 416px"
        referrerpolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
      ></iframe>
      <span class="embedControls" role="group" aria-label="Video window controls">
        <button
          type="button"
          class="embedControls__btn"
          title="Minimize to taskbar"
          aria-label="Minimize video"
          onclick={minimize}
        >&#8722;</button>
        <button
          type="button"
          class="embedControls__btn"
          title="Play in mini player"
          aria-label="Pop out video"
          onclick={popOut}
        >&#9633;</button>
        <button
          type="button"
          class="embedControls__btn embedControls__close"
          title="Close video"
          aria-label="Close video"
          onclick={onClose}
        >×</button>
      </span>
    {/if}
  </span>
{/if}

<style>
  /* .directEmbedWrap / .embedClose (shared with image + GIF embeds) live in
     styles/components/_embeds.scss. */
  :global(.directEmbedWrap.videoWrap) {
    max-width: 416px;
  }
  :global(.iframeEmbed.video) {
    display: block;
    border: 0;
    background: #000;
    max-width: 100%;
  }
  /* Window controls (minimize · pop out · close) over the player's top-right
     corner, desktop-title-bar order. Absolutely positioned so the wrapper's
     height never changes (MessageList observes it), and hover-revealed via
     opacity — never visibility/off-screen — so the buttons keep a real box
     and stay clickable and focusable. */
  .embedControls {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 3;
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.65);
    line-height: 1;
    opacity: 0;
  }
  :global(.directEmbedWrap:hover) .embedControls,
  .embedControls:focus-within {
    opacity: 1;
  }
  .embedControls__btn {
    width: 24px;
    height: 20px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #e5e7eb;
    font-family: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .embedControls__btn:hover {
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
  }
  .embedControls__close {
    font-size: 16px;
  }
  .embedControls__close:hover {
    background: #e5484d;
  }
  .embedControls__btn:focus-visible {
    outline: 1px solid #4a6fa5;
    outline-offset: 1px;
  }
  @media (hover: none) {
    .embedControls {
      opacity: 1;
    }
  }
  :global(.youtubeDocked) {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: #000;
    color: #d1d5db;
    font-size: 13px;
    line-height: 1.4;
  }
  :global(.youtubeDockedReturn) {
    background: #1a1d21;
    color: #d1d5db;
    border: 1px solid #4a6fa5;
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
  }
  @media (max-width: 480px) {
    :global(.directEmbedWrap.videoWrap),
    :global(.iframeEmbed.video),
    :global(.youtubeDocked) {
      width: 100% !important;
      max-width: 100% !important;
    }
  }
</style>
