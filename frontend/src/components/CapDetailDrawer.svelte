<script lang="ts">
  /*
   * CapDetailDrawer — IRCv3-style per-capability detail page.
   *
   * Mirrors IsupportDetailDrawer but for IRCv3 CAP LS tokens. Visual
   * structure matches https://ircv3.net/specs/extensions/away-notify.html:
   *   · Title block (eyebrow + title + abstract)
   *   · "What this does" — 1-3 sentences from the catalog
   *   · "Wire format" — formatted value + interpretation for current server
   *   · "Example" — catalog-supplied example
   *   · Reference footer — IRCv3 link, status badge
   */
  import type { CategorizedCap } from '../lib/capCategorize';
  import type { CapKind } from '../lib/capCatalog';

  interface Props {
    feature: CategorizedCap | null;
    onClose: () => void;
  }

  let { feature, onClose }: Props = $props();

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && feature) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) onClose();
  }

  const STATUS_META: Record<CategorizedCap['status'], { label: string; tone: string }> = {
    core:     { label: 'Core',            tone: 'pill-tone-core' },
    extended: { label: 'Extended',        tone: 'pill-tone-extended' },
    draft:    { label: 'Draft',           tone: 'pill-tone-draft' },
    vendor:   { label: 'Vendor',          tone: 'pill-tone-vendor' },
    ircv3:    { label: 'IRCv3',           tone: 'pill-tone-ircv3' },
    server:   { label: 'Server-specific', tone: 'pill-tone-server' },
  };

  function formatValue(f: CategorizedCap): { html: string; tone: 'plain' | 'amber' | 'cyan' | 'green' } {
    if (f.isFlag) return { html: '<span class="sep-glyph">◇</span> capability advertised', tone: 'cyan' };
    const kind: CapKind = f.catalog?.kind ?? 'value';
    switch (kind) {
      case 'value': {
        // sasl=PLAIN,EXTERNAL  or draft/languages=17,en,...
        if (f.value.includes(',')) {
          const parts = f.value.split(',').map(s => s.trim()).filter(Boolean);
          const html = parts.map(p => `<span class="kv-pill">${escapeHtml(p)}</span>`).join(' ');
          return { html, tone: 'amber' };
        }
        return { html: `<span class="kv-pill">${escapeHtml(f.value)}</span>`, tone: 'amber' };
      }
      default:
        return { html: `<span class="kv-pill">${escapeHtml(f.value)}</span>`, tone: 'amber' };
    }
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function statusCue(f: CategorizedCap): string | null {
    if (!f.catalog) return null;
    if (f.isFlag) return `This server advertises "${f.catalog.title}" as supported.`;
    return `This server publishes "${f.value}" for ${f.catalog.title.toLowerCase()}.`;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if feature}
  <button
    type="button"
    class="isupport-detail__backdrop"
    onclick={handleBackdropClick}
    aria-label="Close capability detail"
    data-testid="cap-detail-backdrop"
  ></button>
  <aside
    class="isupport-detail"
    role="dialog"
    aria-modal="true"
    aria-label="Capability detail"
    data-testid="cap-detail"
  >
    <header class="isupport-detail__head">
      <div class="isupport-detail__head-row">
        <span class="isupport-detail__eyebrow">IRCv3 capability</span>
        <button
          type="button"
          class="isupport-detail__close"
          onclick={onClose}
          aria-label="Close"
          data-testid="cap-detail-close"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <div class="isupport-detail__title-row">
        <h2 class="isupport-detail__key" data-testid="cap-detail-key">{feature.rawKey}</h2>
        <span class="isupport-detail__status {STATUS_META[feature.status].tone}" data-testid="cap-detail-status">
          {STATUS_META[feature.status].label}
        </span>
      </div>

      {#if feature.catalog}
        <p class="isupport-detail__title">
          {feature.catalog.title}
        </p>
      {:else}
        <p class="isupport-detail__title isupport-detail__title--unknown">
          Server-specific capability
        </p>
      {/if}
    </header>

    <div class="isupport-detail__body">
      {#if feature.catalog}
        <p class="isupport-detail__abstract" data-testid="cap-detail-abstract">
          {feature.catalog.short}
        </p>

        <section class="isupport-detail__section" aria-label="Description">
          <h3 class="isupport-detail__section-h">What it does</h3>
          <p class="isupport-detail__paragraph">
            {feature.catalog.detail}
          </p>
        </section>

        <section class="isupport-detail__section" aria-label="Value">
          <h3 class="isupport-detail__section-h">On this server</h3>
          <div class="isupport-detail__valueblock" data-testid="cap-detail-valueblock">
            {@html formatValue(feature).html}
          </div>
          {#if statusCue(feature)}
            <p class="isupport-detail__cue">{statusCue(feature)}</p>
          {/if}
        </section>

        {#if feature.catalog.example && feature.catalog.example !== feature.value && feature.catalog.example !== feature.rawKey}
          <section class="isupport-detail__section" aria-label="Example">
            <h3 class="isupport-detail__section-h">Worked example</h3>
            <pre class="isupport-detail__code"><code>{feature.catalog.example}</code></pre>
          </section>
        {/if}

        <footer class="isupport-detail__footer">
          <div class="isupport-detail__meta">
            {#if feature.catalog.ircv3}
              <a class="isupport-detail__ref" href={feature.catalog.ircv3} target="_blank" rel="noopener noreferrer" data-testid="cap-detail-ircv3">
                IRCv3 spec ↗
              </a>
            {/if}
            {#if feature.catalog.rfc}
              <a class="isupport-detail__ref" href={feature.catalog.rfc} target="_blank" rel="noopener noreferrer" data-testid="cap-detail-rfc">
                RFC ↗
              </a>
            {/if}
            {#if feature.catalog.since}
              <span class="isupport-detail__since" data-testid="cap-detail-since">since {feature.catalog.since}</span>
            {/if}
          </div>
          <a class="isupport-detail__ref isupport-detail__ref--landing" href="https://ircv3.net/irc/" target="_blank" rel="noopener noreferrer">
            ircv3.net/irc ↗
          </a>
        </footer>
      {:else}
        <p class="isupport-detail__abstract">
          "{feature.rawKey}" is not in the IRC Fiber capability catalog — it's specific to this IRCd or bouncer.
        </p>
        <section class="isupport-detail__section" aria-label="Value">
          <h3 class="isupport-detail__section-h">On this server</h3>
          <div class="isupport-detail__valueblock">
            {@html formatValue(feature).html}
          </div>
        </section>
      {/if}
    </div>
  </aside>
{/if}

<style>
  /* Reuse the same visual tokens as IsupportDetailDrawer — duplicate the
     block here so this drawer is self-contained. The class names are
     intentionally shared (.isupport-detail*) so only one CSS block is
     needed when both drawers are on the page. Import parity with the
     Isupport drawer is maintained via copy; any palette change must be
     applied to both files. */
  .isupport-detail__backdrop {
    position: fixed;
    inset: 0;
    background: rgba(6, 10, 14, 0.55);
    backdrop-filter: blur(2px);
    border: none;
    cursor: pointer;
    z-index: 40;
  }
  .isupport-detail {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(520px, 92vw);
    background: #0f141c;
    border-left: 1px solid #1e2835;
    box-shadow: -12px 0 40px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    z-index: 41;
    overflow: hidden;
    animation: cap-drawer-in 140ms ease-out;
  }
  @keyframes cap-drawer-in {
    from { transform: translateX(12px); opacity: 0; }
    to   { transform: translateX(0); opacity: 1; }
  }
  .isupport-detail__head {
    padding: 18px 20px 14px;
    border-bottom: 1px solid #1e2835;
    background: #0e131a;
    flex-shrink: 0;
  }
  .isupport-detail__head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .isupport-detail__eyebrow {
    font: 600 10px/1 ui-monospace, monospace;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #6b7685;
  }
  .isupport-detail__close {
    appearance: none;
    border: 1px solid #243042;
    background: #16202e;
    color: #c8d2dd;
    border-radius: 6px;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
  }
  .isupport-detail__title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .isupport-detail__key {
    font: 700 18px/1.1 ui-monospace, monospace;
    color: #e6edf5;
    margin: 0;
    word-break: break-all;
  }
  .isupport-detail__status {
    font: 600 10px/1 ui-monospace, monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 7px;
    border-radius: 999px;
    border: 1px solid transparent;
  }
  .pill-tone-core    { color: #7cc4ff; border-color: #2a4a6b; background: #122033; }
  .pill-tone-extended{ color: #a8b0bf; border-color: #2a3240; background: #18202d; }
  .pill-tone-draft   { color: #f0c66a; border-color: #4a3d18; background: #2a2210; }
  .pill-tone-vendor  { color: #c9a0ff; border-color: #3d2a5a; background: #1e1430; }
  .pill-tone-ircv3   { color: #6ee7b7; border-color: #1e4638; background: #0f2a22; }
  .pill-tone-server  { color: #8b96a4; border-color: #2a3442; background: #16202e; }
  .isupport-detail__title { font: 600 13px/1.4 system-ui, sans-serif; color: #c8d2dd; margin: 0; }
  .isupport-detail__title--unknown { color: #8b96a4; font-style: italic; }
  .isupport-detail__body { padding: 16px 20px 24px; overflow-y: auto; flex: 1; }
  .isupport-detail__abstract { font: 13px/1.5 system-ui, sans-serif; color: #a8b5c6; margin: 0 0 16px; }
  .isupport-detail__section { margin-bottom: 16px; }
  .isupport-detail__section-h {
    font: 600 11px/1 ui-monospace, monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #6b7685;
    margin: 0 0 8px;
  }
  .isupport-detail__paragraph { font: 13px/1.6 system-ui, sans-serif; color: #c8d2dd; margin: 0; }
  .isupport-detail__valueblock {
    background: #0b0f14;
    border: 1px solid #1e2835;
    border-radius: 6px;
    padding: 10px 12px;
    font: 12px/1.6 ui-monospace, monospace;
    color: #c8d2dd;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .isupport-detail__cue { font: 12px/1.5 system-ui, sans-serif; color: #8b96a4; margin: 8px 0 0; }
  .isupport-detail__code {
    background: #0b0f14;
    border: 1px solid #1e2835;
    border-radius: 6px;
    padding: 10px 12px;
    font: 12px/1.6 ui-monospace, monospace;
    color: #a8b5c6;
    margin: 0;
    overflow-x: auto;
  }
  .isupport-detail__footer {
    margin-top: 18px;
    padding-top: 12px;
    border-top: 1px solid #1e2835;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .isupport-detail__meta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .isupport-detail__ref { font: 12px/1 ui-monospace, monospace; color: #7cc4ff; text-decoration: none; }
  .isupport-detail__ref:hover { text-decoration: underline; }
  .isupport-detail__since { font: 11px/1 ui-monospace, monospace; color: #6b7685; }
  :global(.kv-pill) {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 999px;
    background: #16202e;
    border: 1px solid #243042;
    font: 600 11px/1 ui-monospace, monospace;
    color: #c8d2dd;
  }
  :global(.sep-glyph) { color: #6ee7b7; margin-right: 4px; }
</style>
