<script lang="ts">
  import { onDestroy } from 'svelte';
  import { youtubeEmbedUrl } from '../lib/youtube';
  import {
    attachYoutubeBridge,
    YT_STATE_PLAYING,
    YT_STATE_BUFFERING,
    type YtPlayerInfo,
  } from '../lib/youtubePlayerBridge';
  import { mediaDock, dockVideo, closeDock } from '../stores/mediaDock.svelte';
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

  function onClose(e: MouseEvent): void {
    e.preventDefault();
    closed = true;
  }

  // Explicit pop-out works for paused / never-started videos too (start 0
  // when nothing has been reported yet). The dock URL carries autoplay=1,
  // so a paused video resumes there; intended. stopPropagation keeps the
  // MessageRow click/selection handlers out of it, like the reaction buttons.
  function popOut(e: MouseEvent): void {
    e.stopPropagation();
    dockHere();
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
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_consider_explicit_label -->
      <a
        href=""
        class="embedClose"
        title="Close video"
        style="left: 416px;"
        onclick={onClose}
        role="button"
        aria-label="Close video"
      ></a>
      <button
        type="button"
        class="embedPopout"
        title="Play in mini player"
        aria-label="Pop out video"
        onclick={popOut}
      >Pop out</button>
    {/if}
  </span>
{/if}

<style>
  :global(.directEmbedWrap) {
    position: relative;
    display: block;
    margin: 6px 0 2px 0;
    line-height: 0;
  }
  :global(.directEmbedWrap.videoWrap) {
    max-width: 416px;
  }
  :global(.iframeEmbed.video) {
    display: block;
    border: 0;
    background: #000;
    max-width: 100%;
  }
  /* IRCCloud exact: app/styles/main.scss — hidden off-screen, revealed
     on hover at top:-7px, left from inline style="left:416px" centered with
     margin-left:-12px, 24×24 sprite. */
  :global(.embedClose) {
    position: fixed;
    top: -999px;
    left: -999px;
    width: 0;
    height: 0;
    overflow: hidden;
    background: transparent url('../assets/embed_close.png') no-repeat 0 0;
    background-size: 24px 50px;
    border: 0;
    z-index: 3;
  }
  :global(.directEmbedWrap:hover .embedClose),
  :global(.directEmbedWrap:focus .embedClose),
  :global(.embedClose:hover),
  :global(.embedClose:focus) {
    position: absolute;
    top: -7px;
    width: 24px;
    height: 24px;
    margin-left: -12px;
    overflow: visible;
  }
  :global(.embedClose:hover),
  :global(.embedClose:focus) {
    background-position: 0 -25px;
  }
  /* Pop-out pill over the player's top-left corner. Absolutely positioned
     so the wrapper's height never changes (MessageList observes it), and
     hover-revealed via opacity — never visibility/off-screen — so the
     button keeps a real box and stays clickable and focusable. */
  .embedPopout {
    position: absolute;
    top: 6px;
    left: 6px;
    z-index: 3;
    margin: 0;
    padding: 3px 8px;
    border: 0;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    opacity: 0;
  }
  :global(.directEmbedWrap:hover) .embedPopout,
  .embedPopout:focus-visible {
    opacity: 1;
  }
  .embedPopout:focus-visible {
    outline: 1px solid #4a6fa5;
    outline-offset: 1px;
  }
  @media (hover: none) {
    .embedPopout {
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
