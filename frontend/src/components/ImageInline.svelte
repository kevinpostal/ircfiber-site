<script lang="ts">
  interface Props {
    url: string;
  }
  let { url }: Props = $props();
  // For our own /uploads URLs, use pathname so vite proxy handles http://127.0.0.1:8090 and we avoid https loopback cert failures.
  let displayUrl = $derived((()=>{ try{ const u=new URL(url, location.origin); if(u.pathname.startsWith('/uploads/')) return u.pathname+u.search+u.hash; }catch{} return url; })());

  let closed = $state(false);
  let loaded = $state(false);
  let errored = $state(false);
  let imgEl: HTMLImageElement | undefined = $state(undefined);

  // Position the close button like IRCCloud's setEmbedClosePosition:
  // left = img.clientWidth + img.offsetLeft (here offsetLeft is 0 inside wrap,
  // so effectively img width). We bind via reactive style.
  let closeLeft = $state(0);
  function updateClosePos(): void {
    if (!imgEl) return;
    // Small rAF so layout has settled after image load
    requestAnimationFrame(() => {
      if (!imgEl) return;
      closeLeft = imgEl.clientWidth;
    });
  }

  function onLoad(): void {
    loaded = true;
    errored = false;
    updateClosePos();
  }
  function onError(): void {
    errored = true;
    loaded = false;
  }
  function onClose(e: MouseEvent): void {
    e.preventDefault();
    closed = true;
  }
</script>

{#if !closed && !errored}
  <span class="directEmbedWrap imageWrap" data-image-url={url}>
    <a href={displayUrl} target="_blank" rel="noreferrer" class="imageLink" tabindex="-1">
      <!-- svelte-ignore a11y_missing_attribute -->
      <img
        bind:this={imgEl}
        src={displayUrl}
        alt=""
        class="image"
        class:imageLoaded={loaded}
        class:imageRendered={loaded}
        loading="lazy"
        referrerpolicy="no-referrer"
        onload={onLoad}
        onerror={onError}
      />
    </a>
    {#if loaded}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_consider_explicit_label -->
      <a
        href=""
        class="embedClose"
        title="Close image"
        style:left="{closeLeft}px"
        onclick={onClose}
        role="button"
        aria-label="Close image"
      ></a>
    {/if}
  </span>
{/if}

<style>
  /* IRCCloud parity: image max sizing + render states.
     Mirrors chat.css:
       .embedWrap img.image,.fileWrap img.image,.imageWrap img.image,div.log .media{max-width:92%;max-height:250px}
       div.log img.imageRendered{display:inline-block}
       div.log i.image,div.log img.image{display:none;opacity:0}
       plus directEmbedWrap positioning already defined in YoutubeEmbed (global).
     We keep wrap locally styled too so ImageInline works standalone. */
  :global(.directEmbedWrap.imageWrap) {
    display: block;
    margin: 6px 0 2px 0;
    line-height: 0;
  }
  :global(.directEmbedWrap.imageWrap .imageLink) {
    display: inline-block;
    line-height: 0;
    max-width: 100%;
  }
  :global(.directEmbedWrap.imageWrap img.image) {
    display: block;
    max-width: 92%;
    max-height: 250px;
    width: auto;
    height: auto;
    border-radius: 4px;
    background: #0d1117;
    border: 1px solid rgba(255,255,255,0.08);
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  :global(.directEmbedWrap.imageWrap img.imageLoaded),
  :global(.directEmbedWrap.imageWrap img.imageRendered) {
    opacity: 1;
  }
  :global(.directEmbedWrap.imageWrap img.imageRendered) {
    display: inline-block;
  }
  /* Close button — same sprite as YoutubeEmbed, reuse global .embedClose rules.
     Ensure standalone definition if YoutubeEmbed not mounted in this view. */
  :global(.directEmbedWrap.imageWrap .embedClose) {
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
  :global(.directEmbedWrap.imageWrap:hover .embedClose),
  :global(.directEmbedWrap.imageWrap:focus .embedClose),
  :global(.directEmbedWrap.imageWrap .embedClose:hover),
  :global(.directEmbedWrap.imageWrap .embedClose:focus) {
    position: absolute;
    top: -7px;
    width: 24px;
    height: 24px;
    margin-left: -12px;
    overflow: visible;
  }
  :global(.directEmbedWrap.imageWrap .embedClose:hover),
  :global(.directEmbedWrap.imageWrap .embedClose:focus) {
    background-position: 0 -25px;
  }
  @media (max-width: 480px) {
    :global(.directEmbedWrap.imageWrap img.image) {
      max-width: 100% !important;
    }
  }
</style>
