<script lang="ts">
  import { youtubeEmbedUrl } from '../lib/youtube';

  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  let closed = $state(false);
  let thumbHidden = $state(false);

  const src = $derived(youtubeEmbedUrl(id));

  function onClose(e: MouseEvent): void {
    e.preventDefault();
    closed = true;
  }

  function onThumbClick(e: MouseEvent): void {
    e.preventDefault();
    thumbHidden = true;
  }
</script>

{#if !closed}
  <span class="directEmbedWrap videoWrap" data-youtube-id={id}>
    <iframe
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
      loading="lazy"
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
    <!-- Thumbnail overlay — shows YouTube's hqdefault.jpg centered inside the 416×234 frame.
         IRCCloud's iframe itself shows a thumbnail, but when YouTube returns
         "Video unavailable" we still want a visible preview. This overlay
         sits *on top* of the iframe (absolute, top:0 left:0) and hides on click
         to reveal the iframe player underneath. -->
    {#if !thumbHidden}
    <a href={`https://www.youtube.com/watch?v=${id}`} target="_blank" rel="noreferrer" class="youtubeThumbOverlay" title="Watch on YouTube" onclick={onThumbClick}>
      <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt={`YouTube thumbnail ${id}`} width="416" height="234" loading="lazy" />
      <span class="youtubePlayButton" aria-hidden="true"></span>
    </a>
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
  /* Thumbnail overlay — sits *inside* the 416×234 frame, covering the iframe
     so the preview image is on top of the player bounds, not below. */
  :global(.youtubeThumbOverlay) {
    position: absolute;
    top: 0;
    left: 0;
    width: 416px;
    height: 234px;
    max-width: 416px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    overflow: hidden;
    text-decoration: none;
    z-index: 1;
  }
  :global(.youtubeThumbOverlay img) {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    border: 0;
  }
  :global(.youtubePlayButton) {
    position: absolute;
    width: 68px;
    height: 48px;
    background: rgba(0,0,0,0.6);
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  :global(.youtubePlayButton::before) {
    content: '';
    width: 0;
    height: 0;
    border-left: 18px solid #fff;
    border-top: 12px solid transparent;
    border-bottom: 12px solid transparent;
    margin-left: 4px;
  }
  :global(.youtubeThumbOverlay:hover .youtubePlayButton) {
    background: #ff0000;
  }
  @media (max-width: 480px) {
    :global(.directEmbedWrap.videoWrap),
    :global(.iframeEmbed.video),
    :global(.youtubeThumbOverlay),
    :global(.youtubeThumbOverlay img) {
      width: 100% !important;
      max-width: 100% !important;
    }
  }
</style>
