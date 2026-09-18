<script lang="ts">
  import { mediaDock, closeDock, reportDockPosition } from '../stores/mediaDock.svelte';
  import { youtubeEmbedUrl } from '../lib/youtube';
  import { attachYoutubeBridge } from '../lib/youtubePlayerBridge';

  interface Props {
    onSwitchBuffer: (networkId: string, bufferName: string) => void;
  }

  let { onSwitchBuffer }: Props = $props();

  let iframeEl = $state<HTMLIFrameElement | undefined>();

  // Derived from startSeconds only — reading the live positionSeconds here
  // would reload the iframe on every info tick.
  const src = $derived(
    mediaDock.video
      ? youtubeEmbedUrl(mediaDock.video.videoId, { start: mediaDock.video.startSeconds, autoplay: true })
      : '',
  );

  $effect(() => {
    if (!iframeEl) return;
    return attachYoutubeBridge(iframeEl, (info) => {
      if (info.currentTime !== undefined) reportDockPosition(info.currentTime);
    });
  });
</script>

{#if mediaDock.video}
  <div class="mediaDock" role="region" aria-label="Mini player">
    <div class="mediaDock__bar">
      <span class="mediaDock__title">YouTube</span>
      {#if mediaDock.video.origin}
        {@const origin = mediaDock.video.origin}
        <button
          type="button"
          class="mediaDock__btn"
          onclick={() => onSwitchBuffer(origin.networkId, origin.bufferName)}
        >Go to channel</button>
      {/if}
      <button
        type="button"
        class="mediaDock__btn mediaDock__close"
        aria-label="Close mini player"
        onclick={closeDock}
      >×</button>
    </div>
    {#key mediaDock.video.videoId}
      <iframe
        bind:this={iframeEl}
        type="text/html"
        class="mediaDock__frame"
        {src}
        title="YouTube video {mediaDock.video.videoId}"
        allowfullscreen
        sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-presentation"
        referrerpolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
      ></iframe>
    {/key}
  </div>
{/if}

<style>
  /* z-index 95: above chat chrome (input 20, floating date 10), below
     modals/overlays (99/100) and context menus (400). */
  .mediaDock {
    position: fixed;
    right: 16px;
    bottom: 76px;
    width: 320px;
    max-width: calc(100vw - 32px);
    z-index: 95;
    background: #1a1d21;
    border: 1px solid #2c2f35;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  .mediaDock__bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    font-size: 12px;
    color: #8b949e;
  }
  .mediaDock__title {
    flex: 1;
  }
  .mediaDock__btn {
    background: none;
    border: 0;
    color: #d1d5db;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 6px;
  }
  .mediaDock__close {
    font-size: 16px;
    line-height: 1;
  }
  .mediaDock__frame {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    border: 0;
    background: #000;
  }
</style>
