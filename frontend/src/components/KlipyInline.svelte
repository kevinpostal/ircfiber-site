<script lang="ts">
  import { proxiedImageUrl } from '../lib/imageInline';
  import { klipyEmbedUrl, type KlipyEmbed } from '../lib/klipyInline';

  interface Props {
    slug: string;
  }
  let { slug }: Props = $props();

  // Resolved renditions per slug, shared across rows: the same GIF pasted
  // twice (or re-rendered on scroll) costs one gateway round trip.
  const resolved = new Map<string, Promise<KlipyEmbed | null>>();
  function resolve(s: string): Promise<KlipyEmbed | null> {
    let p = resolved.get(s);
    if (!p) {
      p = fetch(klipyEmbedUrl(s), { credentials: 'same-origin' })
        .then((r) => (r.ok ? (r.json() as Promise<KlipyEmbed>) : null))
        .catch(() => null);
      resolved.set(s, p);
    }
    return p;
  }

  let embed = $state<KlipyEmbed | null>(null);
  let closed = $state(false);
  let loaded = $state(false);
  let errored = $state(false);
  let imgEl: HTMLImageElement | undefined = $state(undefined);
  let closeLeft = $state(0);

  $effect(() => {
    const s = slug;
    let live = true;
    embed = null; loaded = false; errored = false;
    void resolve(s).then((e) => { if (live) embed = e; });
    return () => { live = false; };
  });

  // Animated WebP through the image proxy (no client IP to the CDN), GIF
  // when a rendition is missing WebP. Same 250px cap as ImageInline.
  const src = $derived(embed ? proxiedImageUrl((embed.webp ?? embed.gif)!.url) : '');
  const page = $derived(embed?.page ?? `https://klipy.com/gifs/${slug}`);

  function onLoad(): void {
    loaded = true;
    requestAnimationFrame(() => { if (imgEl) closeLeft = imgEl.clientWidth; });
  }
  function onClose(e: MouseEvent): void {
    e.preventDefault();
    closed = true;
  }
</script>

{#if embed && !closed && !errored}
  <span class="directEmbedWrap imageWrap klipyWrap" data-klipy-slug={slug}>
    <a href={page} target="_blank" rel="noreferrer" class="imageLink" tabindex="-1" title={embed.title || 'KLIPY GIF'}>
      <img
        bind:this={imgEl}
        src={src}
        alt={embed.title || 'GIF'}
        class="image"
        class:imageLoaded={loaded}
        class:imageRendered={loaded}
        width={(embed.webp ?? embed.gif)?.width || undefined}
        height={(embed.webp ?? embed.gif)?.height || undefined}
        referrerpolicy="no-referrer"
        decoding="async"
        onload={onLoad}
        onerror={() => { errored = true; }}
      />
    </a>
    {#if loaded}
      <!-- KLIPY's API terms require attribution wherever their content shows. -->
      <a href="https://klipy.com" target="_blank" rel="noreferrer" class="klipyBadge">via KLIPY</a>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_consider_explicit_label -->
      <a href="" class="embedClose" title="Close GIF" style:left="{closeLeft}px" onclick={onClose} role="button" aria-label="Close GIF"></a>
    {/if}
  </span>
{/if}

<style>
  :global(.directEmbedWrap.klipyWrap) { position: relative; }
  :global(.directEmbedWrap.klipyWrap .klipyBadge) {
    display: block;
    line-height: 1.2;
    font-size: 10px;
    color: #6e7681;
    text-decoration: none;
    margin-top: 2px;
  }
  :global(.directEmbedWrap.klipyWrap .klipyBadge:hover) { color: #8b949e; text-decoration: underline; }
</style>
