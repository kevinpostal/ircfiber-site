<script lang="ts">
  import Highlight, { LineNumbers } from 'svelte-highlight';
  import 'svelte-highlight/styles/atom-one-dark.css';
  import xml from 'svelte-highlight/languages/xml';
  import { HTML_EXT_RE } from '../lib/htmlInline';

  interface Props {
    url: string;
    filename?: string;
    fetchContent?: string | null;
    compact?: boolean;
    withFrame?: boolean;
    highlightLang?: any;
  }
  let { url, filename, fetchContent = null, compact = false, withFrame = true, highlightLang = null }: Props = $props();

  let pathnameUrl = $derived((() => { try { const u = new URL(url, location.origin); return u.pathname + u.search + u.hash; } catch { return url; } })());
  let displayUrl = $derived((() => { try { const u = new URL(url, location.origin); if (u.pathname.startsWith('/uploads/')) return u.pathname + u.search + u.hash; } catch {} return url; })());
  let previewSrc = $derived(displayUrl);
  let downloadHref = $derived((() => { try { const u = new URL(displayUrl, location.origin); const sep = u.search ? '&' : '?'; return displayUrl + sep + 'download=1'; } catch { return displayUrl + '?download=1'; } })());

  let isHtml = $derived(HTML_EXT_RE.test(filename ?? url));

  let activeTab: 'preview' | 'source' | 'raw' = $state(isHtml && withFrame ? 'preview' : 'source');
  let sourceText: string | null = $state(fetchContent);
  let loadError: string | null = $state(null);

  // Keep activeTab in sync if withFrame/isHtml changes after mount
  $effect(() => {
    if (isHtml && withFrame && activeTab === 'source' && sourceText === null) {
      // default remains source until loaded, but ensure preview is default for html when possible
    }
  });

  $effect(() => {
    if (fetchContent !== null) {
      sourceText = fetchContent;
      loadError = null;
      return;
    }
    let cancelled = false;
    sourceText = null;
    loadError = null;
    const fetchUrl = pathnameUrl;
    fetch(fetchUrl).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      if (cancelled) return;
      const truncated = t.length > 50000 ? t.slice(0, 50000) + '\n\n... truncated ...' : t;
      sourceText = truncated;
    }).catch((e) => {
      if (cancelled) return;
      loadError = e?.message ?? 'Failed to load';
    });
    return () => { cancelled = true; };
  });

  function reload() {
    // trigger effect by resetting sourceText
    sourceText = null;
    loadError = null;
    const fetchUrl = pathnameUrl;
    fetch(fetchUrl).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      const truncated = t.length > 50000 ? t.slice(0, 50000) + '\n\n... truncated ...' : t;
      sourceText = truncated;
    }).catch((e) => {
      loadError = e?.message ?? 'Failed to load';
    });
  }

  let hl = $derived(highlightLang ?? xml);
</script>

<div class="htmlPreviewTabs" class:compact data-url={url}>
  <div class="htmlPreviewTabBar" role="tablist">
    {#if withFrame}
      <button role="tab" aria-selected={activeTab==='preview'} onclick={()=>activeTab='preview'}>Preview</button>
    {/if}
    <button role="tab" aria-selected={activeTab==='source'} onclick={()=>activeTab='source'}>Source</button>
    <button role="tab" aria-selected={activeTab==='raw'} onclick={()=>activeTab='raw'}>Raw</button>
    <a class="htmlDownloadBtn" href={downloadHref} download={filename ?? ''} aria-label="Download">Download</a>
    <a class="htmlOpenBtn" href={displayUrl} target="_blank" rel="noreferrer">Open</a>
  </div>
  {#if withFrame && activeTab==='preview'}
    <div class="htmlPreviewFrameWrap"><iframe title={filename ?? 'Preview'} src={previewSrc} sandbox="allow-scripts allow-popups" loading="lazy"></iframe></div>
  {:else if activeTab==='source'}
    <div class="htmlSourceWrap">
      {#if sourceText !== null}<Highlight language={hl} code={sourceText} let:highlighted><LineNumbers {highlighted} /></Highlight>
      {:else if loadError}<div class="htmlLoadError">{loadError} <button onclick={reload}>Retry</button></div>
      {:else}Loading...{/if}
    </div>
  {:else}
    <pre class="htmlRawPre">{sourceText ?? 'Loading...'}</pre>
  {/if}
</div>

<style>
  .htmlPreviewTabs { display: flex; flex-direction: column; gap: 8px; }
  .htmlPreviewTabBar { display: flex; gap: 6px; align-items: center; border-bottom: 1px solid var(--border, #2a2d33); padding-bottom: 6px; flex-wrap: wrap; }
  .htmlPreviewTabBar button[role="tab"] { background: transparent; border: none; border-bottom: 2px solid transparent; padding: 4px 8px; cursor: pointer; color: var(--text, #c9d1d9); font-size: 13px; }
  .htmlPreviewTabBar button[role="tab"][aria-selected="true"] { border-bottom-color: var(--primary, #5ea1ff); color: var(--primary, #5ea1ff); font-weight: 600; }
  .htmlDownloadBtn, .htmlOpenBtn { margin-left: auto; font-size: 12px; padding: 4px 8px; border: 1px solid var(--border, #2a2d33); border-radius: 4px; text-decoration: none; color: var(--text, #c9d1d9); background: var(--bg, #161a22); }
  .htmlDownloadBtn { margin-left: 8px; }
  .htmlOpenBtn { margin-left: 6px; }
  .htmlPreviewFrameWrap { border: 1px solid var(--border, #2a2d33); border-radius: 4px; overflow: hidden; background: #fff; }
  .htmlPreviewFrameWrap iframe { width: 100%; height: min(60vh, 560px); border: none; background: #fff; display: block; }
  .compact .htmlPreviewFrameWrap iframe { height: 260px; }
  .htmlSourceWrap { background: #1e1e1e; color: #e6e6e6; padding: 10px; border-radius: 3px; max-height: 320px; overflow: auto; }
  .compact .htmlSourceWrap { max-height: 260px; }
  .htmlRawPre { background: #1e1e1e; color: #e6e6e6; padding: 10px; border-radius: 3px; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin: 0; }
  .htmlLoadError { color: #f08888; font-size: 12px; }
  .htmlLoadError button { margin-left: 8px; }
</style>
