<script lang="ts">
  /*
   * IsupportDetailDrawer — IRCv3-style per-feature detail page.
   *
   * Mirrors the visual structure of https://ircv3.net/specs/extensions/away-notify.html:
   *    · Title block (eyebrow + title + abstract)
   *    · "What this does" — 1–3 sentences from the catalog
   *    · "Wire format" — formatted value + interpretation for the current server
   *    · "Example" — catalog-supplied example, or this server's first value
   *    · Reference footer — RFC link, IRCv3 link, status badge
   *
   * Only shown when `feature` is non-null.  Backdrop click + ESC dismiss.
   */
  import type { CategorizedFeature } from '../lib/isupportCategorize';
  import type { IsupportKind } from '../lib/isupportCatalog';

  interface Props {
    feature: CategorizedFeature | null;
    onClose: () => void;
  }

  let { feature, onClose }: Props = $props();

  // ── Esc to close ────────────────────────────────────────────────────
  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && feature) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  // ── Backdrop click ─────────────────────────────────────────────────
  function handleBackdropClick(e: MouseEvent): void {
    // Only close when the click lands on the backdrop itself, not on
    // any of its children — the click bubbles up to here when a child
    // dispatches a click.
    if (e.target === e.currentTarget) onClose();
  }

  // ── Status pill ────────────────────────────────────────────────────
  const STATUS_META: Record<CategorizedFeature['status'], { label: string; tone: string }> = {
    core:      { label: 'Core / RFC', tone: 'pill-tone-core' },
    extended:  { label: 'Extended',   tone: 'pill-tone-extended' },
    draft:     { label: 'Draft',      tone: 'pill-tone-draft' },
    legacy:    { label: 'Legacy',     tone: 'pill-tone-legacy' },
    ircv3:     { label: 'IRCv3',      tone: 'pill-tone-ircv3' },
    server:    { label: 'Server-specific', tone: 'pill-tone-server' },
  };

  // ── Value formatter ────────────────────────────────────────────────
  // Different kinds render their value differently:
  //   · int          → monospace chip "<n>"
  //   · enum         → monospace chip + per-value spotlight
  //   · string       → monospace chip (long strings get a tooltip)
  //   · prefix-list  → split into the parenthesised mode side and the symbol side,
  //                    and render each as a stack of mini-chips
  //   · mode-list    → split on commas into 4 categories and render each pill
  //   · mask         → show each letter as its own pill (e.g. MN → 2 chips)
  //   · pair         → split on commas → "KEY=VALUE:VAL2"
  //   · language     → list of language pills
  //   · flag         → "support declared" (no value)
  function formatValue(f: CategorizedFeature): { html: string; tone: 'plain' | 'amber' | 'cyan' | 'green' } {
    if (f.isFlag) return { html: '<span class="sep-glyph">◇</span> support declared', tone: 'cyan' };
    const kind: IsupportKind = f.catalog?.kind ?? 'string';
    switch (kind) {
      case 'int':
        return { html: `<span class="kv-pill">${escapeHtml(f.value)}</span>`, tone: 'amber' };
      case 'enum': {
        // Highlight when the server's value matches one of the catalog enums
        const isAllowed = f.catalog?.values?.includes(f.value) ?? false;
        return {
          html: `<span class="kv-pill ${isAllowed ? 'kv-pill--ok' : 'kv-pill--warn'}">${escapeHtml(f.value)}</span>`,
          tone: isAllowed ? 'green' : 'amber',
        };
      }
      case 'prefix-list': {
        // PREFIX=(qaohv)~&@%+
        const m = f.value.match(/^\(([^)]*)\)(.*)$/);
        if (!m) return { html: `<span class="kv-pill">${escapeHtml(f.value)}</span>`, tone: 'amber' };
        const modes = m[1];
        const symbols = m[2];
        const pairs: string[] = [];
        const len = Math.min(modes.length, symbols.length);
        for (let i = 0; i < len; i += 1) {
          pairs.push(
            `<span class="kv-pair"><span class="kv-mode">${escapeHtml(modes[i])}</span>` +
            `<span class="kv-arrow">→</span>` +
            `<span class="kv-symbol">${escapeHtml(symbols[i])}</span></span>`
          );
        }
        return { html: pairs.join(' '), tone: 'plain' };
      }
      case 'mode-list': {
        // CHANMODES is "<A>cat>,<B>cat>,<C>cat>,<D>cat>"
        const segs = f.value.split(',');
        const labels = ['list (A)', 'param (B)', 'toggle (C)', 'param-mode (D)'];
        const html = segs
          .map((seg, i) => {
            if (!seg) return '';
            return `<span class="kv-modegroup"><span class="kv-modegroup-label">${escapeHtml(labels[i] ?? `group ${i + 1}`)}</span><span class="kv-modegroup-vals">${seg.split('').map((c) => `<span class="kv-mini">${escapeHtml(c)}</span>`).join('')}</span></span>`;
          })
          .join('<span class="kv-sep">·</span>');
        return { html, tone: 'plain' };
      }
      case 'mask': {
        // ELIST=MNUT → 4 chips
        const letters = f.value.split('');
        const html = letters.map((l) => `<span class="kv-mini">${escapeHtml(l)}</span>`).join(' ');
        return { html, tone: 'amber' };
      }
      case 'pair': {
        // KEY=A,B  or  CHANLIMIT=#:10,&:5
        const segs = f.value.split(',');
        const sep = f.value.includes(':') ? ':' : '=';
        const html = segs.map((seg) => `<span class="kv-pill">${escapeHtml(seg.replace('=', ' = '))}</span>`).join('');
        return { html, tone: 'amber' };
      }
      case 'language': {
        const langs = f.value.split(',');
        const html = langs.map((l) => `<span class="kv-mini">${escapeHtml(l.trim())}</span>`).join(' ');
        return { html, tone: 'amber' };
      }
      case 'string':
      case 'time':
      default:
        return { html: `<span class="kv-pill">${escapeHtml(f.value)}</span>`, tone: 'amber' };
    }
  }

  // ── Tiny HTML escaper (svelte does this for `{value}` but the
  //    structured formatter outputs raw HTML, so we escape inside
  //    the formatter; this is just for any future string field) ─────
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Helper: status-cue sentence (e.g. "Server uses ascii mapping") ──
  function statusCue(f: CategorizedFeature): string | null {
    if (!f.catalog) return null;
    if (f.isFlag) return `This server advertises "${f.catalog.title}" as supported.`;
    switch (f.catalog.kind) {
      case 'int':
        return `This server caps the value at ${f.value}.`;
      case 'enum':
        if (f.catalog.values?.includes(f.value)) {
          return `The server uses "${f.value}" — one of the accepted values.`;
        }
        return `The server uses "${f.value}", which is outside the documented value set (${(f.catalog.values ?? []).join(', ')}).`;
      case 'string':
        return `This server publishes "${f.value}".`;
      case 'pair':
        return `Maps: ${f.value.split(',').join(', ')}.`;
      case 'prefix-list': {
        const m = f.value.match(/^\(([^)]*)\)(.*)$/);
        if (!m) return null;
        return `${m[1].length} channel user-mode${m[1].length === 1 ? '' : 's'} (${m[1]}) mapped to ${m[2].length} visual prefix symbol${m[2].length === 1 ? '' : 's'} (${m[2]}).`;
      }
      case 'mode-list': {
        const segs = f.value.split(',');
        return `${segs.length} mode categor${segs.length === 1 ? 'y' : 'ies'}: ${segs.map((s, i) => `[${['A','B','C','D'][i] ?? '?'}] ${s || '∅'}`).join(' · ')}.`;
      }
      case 'mask':
        return `${f.value.length} LIST-extension flag${f.value.length === 1 ? '' : 's'}: ${f.value.split('').join(', ')}.`;
      case 'language':
        return `${f.value.split(',').length} language${f.value.split(',').length === 1 ? '' : 's'} supported: ${f.value}.`;
      default:
        return null;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if feature}
  <button
    type="button"
    class="isupport-detail__backdrop"
    onclick={handleBackdropClick}
    aria-label="Close server feature detail"
    data-testid="isupport-detail-backdrop"
  ></button>
  <div
    class="isupport-detail"
    role="dialog"
    aria-modal="true"
    aria-label="Server feature detail"
    data-testid="isupport-detail"
  >
    <header class="isupport-detail__head">
      <div class="isupport-detail__head-row">
        <span class="isupport-detail__eyebrow">Server feature</span>
        <button
          type="button"
          class="isupport-detail__close"
          onclick={onClose}
          aria-label="Close"
          data-testid="isupport-detail-close"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <div class="isupport-detail__title-row">
        <h2 class="isupport-detail__key" data-testid="isupport-detail-key">{feature.rawKey}</h2>
        <span class="isupport-detail__status {STATUS_META[feature.status].tone}" data-testid="isupport-detail-status">
          {STATUS_META[feature.status].label}
        </span>
      </div>

      {#if feature.catalog}
        <p class="isupport-detail__title">
          {feature.catalog.title}
        </p>
      {:else}
        <p class="isupport-detail__title isupport-detail__title--unknown">
          Server-specific extension
        </p>
      {/if}
    </header>

    <div class="isupport-detail__body">
      {#if feature.catalog}
        <p class="isupport-detail__abstract" data-testid="isupport-detail-abstract">
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
          <div class="isupport-detail__valueblock" data-testid="isupport-detail-valueblock">
            {@html formatValue(feature).html}
          </div>
          {#if statusCue(feature)}
            <p class="isupport-detail__cue">{statusCue(feature)}</p>
          {/if}
        </section>

        {#if feature.catalog.example && feature.catalog.example !== feature.value}
          <section class="isupport-detail__section" aria-label="Example">
            <h3 class="isupport-detail__section-h">Worked example</h3>
            <pre class="isupport-detail__code"><code>{feature.catalog.example}</code></pre>
          </section>
        {/if}

        <footer class="isupport-detail__footer">
          <h3 class="isupport-detail__section-h">Reference</h3>
          <ul class="isupport-detail__refs">
            {#if feature.catalog.rfc}
              <li>
                <a class="isupport-detail__ref" href={feature.catalog.rfc} target="_blank" rel="noopener noreferrer">
                  <span class="isupport-detail__ref-kind">RFC</span>
                  <span class="isupport-detail__ref-label">{feature.catalog.rfc}</span>
                </a>
              </li>
            {/if}
            {#if feature.catalog.ircv3}
              <li>
                <a class="isupport-detail__ref" href={feature.catalog.ircv3} target="_blank" rel="noopener noreferrer">
                  <span class="isupport-detail__ref-kind">IRCv3</span>
                  <span class="isupport-detail__ref-label">{feature.catalog.ircv3}</span>
                </a>
              </li>
            {/if}
            {#if feature.catalog.since}
              <li class="isupport-detail__ref-meta">
                <span class="isupport-detail__ref-kind isupport-detail__ref-kind--meta">Since</span>
                <span class="isupport-detail__ref-label">{feature.catalog.since}</span>
              </li>
            {/if}
            {#if !feature.catalog.rfc && !feature.catalog.ircv3}
              <li class="isupport-detail__ref-meta isupport-detail__ref-meta--muted">
                No canonical spec — this token is broadly accepted across IRCds but not in any RFC or IRCv3 spec.
              </li>
            {/if}
          </ul>
        </footer>
      {:else}
        <p class="isupport-detail__abstract">
          "{feature.rawKey}" is not in the IRC Fiber standard-catalog of ISUPPORT tokens — it's specific to this IRCd.
        </p>
        <section class="isupport-detail__section" aria-label="Value">
          <h3 class="isupport-detail__section-h">Raw value</h3>
          <div class="isupport-detail__valueblock">
            {@html formatValue(feature).html}
          </div>
        </section>
      {/if}
    </div>
  </div>
{/if}

<style>
  .isupport-detail__backdrop {
    position: fixed;
    inset: 0;
    background: rgba(8, 13, 19, 0.55);
    backdrop-filter: blur(2px);
    border: 0;
    padding: 0;
    cursor: pointer;
    z-index: 50;
    animation: isupport-fade-in 140ms ease-out;
  }

  .isupport-detail {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(440px, 100vw);
    background: var(--fiber-ink, #0e131a);
    color: var(--fiber-cloud, #c8d2dd);
    border-left: 1px solid var(--fiber-line, #1a212b);
    box-shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
    z-index: 51;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    animation: isupport-slide-in 200ms cubic-bezier(0.22, 1, 0.36, 1);
    font-family: var(--font-sans, system-ui, sans-serif);
  }

  @keyframes isupport-fade-in {
    from { opacity: 0; } to { opacity: 1; }
  }
  @keyframes isupport-slide-in {
    from { transform: translateX(100%); opacity: 0; }
    to   { transform: translateX(0);    opacity: 1; }
  }

  .isupport-detail__head {
    padding: 18px 22px 14px;
    border-bottom: 1px solid var(--fiber-line, #1a212b);
    background: linear-gradient(
      180deg,
      var(--fiber-blue-soft, rgba(103, 232, 249, 0.04)) 0%,
      transparent 100%
    );
  }

  .isupport-detail__head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .isupport-detail__eyebrow {
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--fiber-blue, #67e8f9);
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .isupport-detail__eyebrow::before {
    content: "";
    width: 18px;
    height: 1px;
    background: var(--fiber-blue, #67e8f9);
    box-shadow: 0 0 6px var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
  }

  .isupport-detail__close {
    background: transparent;
    border: 1px solid var(--fiber-line, #1a212b);
    color: var(--fiber-fog, #8b96a4);
    width: 28px;
    height: 28px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 120ms ease, color 120ms ease;
  }
  .isupport-detail__close:hover {
    background: rgba(255, 255, 255, 0.04);
    color: var(--fiber-snow, #ecf2f8);
  }
  .isupport-detail__close:focus-visible {
    outline: 2px solid var(--fiber-blue, #67e8f9);
    outline-offset: 2px;
  }

  .isupport-detail__title-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }

  .isupport-detail__key {
    margin: 0;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 22px;
    font-weight: 600;
    color: var(--fiber-snow, #ecf2b8);
    letter-spacing: -0.005em;
    word-break: break-all;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--fiber-line, #1a212b);
    border-radius: 4px;
    padding: 4px 10px;
  }

  .isupport-detail__status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid currentColor;
  }
  .pill-tone-core       { color: #34d399; background: rgba(52, 211, 153, 0.10); }
  .pill-tone-extended   { color: #67e8f9; background: rgba(103, 232, 249, 0.10); }
  .pill-tone-draft      { color: #fbbf24; background: rgba(251, 191, 36, 0.10); }
  .pill-tone-legacy     { color: #a78bfa; background: rgba(167, 139, 250, 0.10); }
  .pill-tone-ircv3      { color: #f472b6; background: rgba(244, 114, 182, 0.10); }
  .pill-tone-server     { color: var(--fiber-fog, #8b96a4); background: rgba(139, 150, 164, 0.10); }

  .isupport-detail__title {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--fiber-fog, #8b96a4);
    font-weight: 400;
    line-height: 1.5;
  }
  .isupport-detail__title--unknown {
    color: var(--fiber-mist, #4d5867);
    font-style: italic;
  }

  .isupport-detail__body {
    flex: 1;
    padding: 18px 22px 32px;
    overflow-y: auto;
  }

  .isupport-detail__abstract {
    margin: 0 0 20px;
    padding: 0;
    font-size: 14px;
    line-height: 1.6;
    color: var(--fiber-cloud, #c8d2dd);
    border-left: 2px solid var(--fiber-blue, #67e8f9);
    padding-left: 14px;
    margin-left: -2px;
  }

  .isupport-detail__section {
    margin: 0 0 22px;
  }

  .isupport-detail__section-h {
    margin: 0 0 8px;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--fiber-mist, #4d5867);
    font-weight: 600;
  }

  .isupport-detail__paragraph {
    margin: 0;
    font-size: 13px;
    line-height: 1.65;
    color: var(--fiber-cloud, #c8d2dd);
  }

  .isupport-detail__valueblock {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 12px 14px;
    background: var(--fiber-paper, #0a0e14);
    border: 1px solid var(--fiber-line, #1a212b);
    border-radius: 4px;
    margin-bottom: 8px;
    min-height: 38px;
    align-items: center;
  }

  .isupport-detail__cue {
    margin: 0;
    font-size: 12px;
    color: var(--fiber-fog, #8b96a4);
    line-height: 1.5;
    font-style: italic;
  }

  .isupport-detail__code {
    margin: 0;
    padding: 10px 12px;
    background: var(--fiber-paper, #0a0e14);
    border: 1px solid var(--fiber-line, #1a212b);
    border-radius: 4px;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 12px;
    color: var(--fiber-amber, #fbbf24);
    overflow-x: auto;
  }

  .isupport-detail__footer {
    margin-top: 28px;
    padding-top: 16px;
    border-top: 1px solid var(--fiber-line, #1a212b);
  }

  .isupport-detail__refs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .isupport-detail__ref,
  .isupport-detail__ref-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--fiber-fog, #8b96a4);
    word-break: break-all;
  }
  .isupport-detail__ref {
    text-decoration: none;
    color: inherit;
    padding: 6px 8px;
    border-radius: 3px;
    transition: background 120ms ease;
  }
  .isupport-detail__ref:hover {
    background: rgba(103, 232, 249, 0.05);
    color: var(--fiber-cloud, #c8d2dd);
  }
  .isupport-detail__ref-kind {
    flex-shrink: 0;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 3px 7px;
    border-radius: 3px;
    color: var(--fiber-blue, #67e8f9);
    background: rgba(103, 232, 249, 0.10);
    border: 1px solid rgba(103, 232, 249, 0.25);
  }
  .isupport-detail__ref-kind--meta {
    color: var(--fiber-mist, #4d5867);
    background: rgba(77, 88, 103, 0.10);
    border-color: var(--fiber-line, #1a212b);
  }
  .isupport-detail__ref-label {
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 11px;
  }
  .isupport-detail__ref-meta--muted {
    color: var(--fiber-mist, #4d5867);
    font-style: italic;
  }

  /* ── Value-chip primitives (global so {@html} blocks can hit them) ── */
  :global(.kv-pill) {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 12px;
    padding: 4px 9px;
    background: rgba(251, 191, 36, 0.10);
    color: var(--fiber-amber, #fbbf24);
    border: 1px solid rgba(251, 191, 36, 0.30);
    border-radius: 3px;
    letter-spacing: -0.005em;
  }
  :global(.kv-pill--ok) {
    background: rgba(52, 211, 153, 0.10);
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.30);
  }
  :global(.kv-pill--warn) {
    background: rgba(248, 113, 113, 0.10);
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.30);
  }
  :global(.kv-pair) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px;
    border: 1px solid var(--fiber-line, #1a212b);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.02);
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 12px;
  }
  :global(.kv-mode) {
    color: var(--fiber-mist, #4d5867);
    background: rgba(255, 255, 255, 0.04);
    padding: 1px 5px;
    border-radius: 2px;
    font-weight: 600;
  }
  :global(.kv-symbol) {
    color: var(--fiber-blue, #67e8f9);
    font-weight: 700;
  }
  :global(.kv-arrow) {
    color: var(--fiber-mist, #4d5867);
    font-size: 10px;
  }
  :global(.kv-modegroup) {
    display: inline-flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 8px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--fiber-line, #1a212b);
    border-radius: 3px;
  }
  :global(.kv-modegroup-label) {
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 9px;
    color: var(--fiber-mist, #4d5867);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  :global(.kv-modegroup-vals) {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  :global(.kv-mini) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 11px;
    font-weight: 600;
    color: var(--fiber-blue, #67e8f9);
    background: rgba(103, 232, 249, 0.10);
    border-radius: 2px;
  }
  :global(.kv-sep) {
    color: var(--fiber-mist, #4d5867);
    margin: 0 4px;
    align-self: center;
  }
  :global(.sep-glyph) {
    color: var(--fiber-blue, #67e8f9);
    font-size: 14px;
    margin-right: 4px;
  }
</style>
