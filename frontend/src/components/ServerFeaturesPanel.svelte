<script lang="ts">
  /*
   * ServerFeaturesPanel — categorized overview of every
   * ISUPPORT / 005 token the connected server advertised.
   *
   * Replaces the previous flat `<ul class="isupport-list">` rendered
   * directly inline in `ServerLogTimeline.svelte`. The new layout
   * groups tokens by purpose (Identity, Channels, Modes, IRCv3, …) and
   * makes each row clickable to open the `IsupportDetailDrawer`
   * (mirrors the visual structure of IRCv3's per-extension spec pages).
   *
   * Compactness targets:
   *   · Header line with network name, IRCD product, summary counts
   *     ("48 features · 8 categories · 12 IRCv3")
   *   · One card per category, collapse-expandable per local state
   *   · Compact, monospace rows: {badge}{key}{=value}{short}
   *   · Click anywhere on a row → opens the drawer
   *
   * The component owns its own drawer state (single instance) so it
   * is fully self-contained. Parents only need to pass the raw isupport
   * record. Pass nothing → empty / no-network state.
   */
  import {
    categorizeIsupport,
    isupportStats,
    type CategorizedFeature,
    type CategorizedGroup,
  } from '../lib/isupportCategorize';
  import IsupportDetailDrawer from './IsupportDetailDrawer.svelte';

  interface Props {
    isupport?: Record<string, string> | null;
    /** When true, render the toolbar collapsed by default (good for
     *  embed in the server-log timeline where space is limited). */
    dense?: boolean;
    /** Title to use in the header when no NETWORK= was published */
    titleFallback?: string;
  }

  let { isupport, dense = false, titleFallback = 'Server' }: Props = $props();

  // ── Derived: groups & stats (memoized by `isupport` identity) ──────
  const groups = $derived<CategorizedGroup[]>(
    isupport ? categorizeIsupport(isupport) : []
  );
  const stats = $derived(isupportStats(groups));

  // ── Whole-panel collapse (persisted across reloads) ──────────────
  // Independent of per-category collapse so the user can fold the entire
  // ISUPPORT inventory down to a one-line header (network name + feature
  // counts) without having to click each category. Default expanded; the
  // toggle on the header controls it. Persisted in localStorage so a
  // dense timeline embed stays collapsed across page refreshes.
  function loadCollapsed(): boolean {
    try {
      const raw = localStorage.getItem('ircfiber:serverFeaturesCollapsed');
      if (raw === null) return true;
      return JSON.parse(raw) === true;
    } catch {
      return true;
    }
  }
  function saveCollapsed(v: boolean): void {
    try {
      localStorage.setItem('ircfiber:serverFeaturesCollapsed', JSON.stringify(v));
    } catch {
      /* storage unavailable — collapse state just won't persist */
    }
  }
  let panelCollapsed = $state<boolean>(dense ? true : loadCollapsed());
  $effect(() => {
    saveCollapsed(panelCollapsed);
  });
  function togglePanel(): void {
    panelCollapsed = !panelCollapsed;
  }

  // ── Per-category collapse state (default-expand all, or respect dense) ──
  let collapsed = $state<Record<string, boolean>>({});
  $effect(() => {
    // When the panel is dense (embedded in the timeline) collapse every
    // category by default; otherwise expand every category. Only
    // initialize unset keys so manual toggles survive re-syncs.
    const init = dense;
    for (const g of groups) {
      if (!(g.category.id in collapsed)) {
        collapsed[g.category.id] = init;
      }
    }
  });
  function toggleCategory(id: string): void {
    collapsed = { ...collapsed, [id]: !collapsed[id] };
  }

  // ── Drawer state ──────────────────────────────────────────────────
  let activeFeature = $state<CategorizedFeature | null>(null);
  function openFeature(f: CategorizedFeature): void {
    activeFeature = f;
  }
  function closeFeature(): void {
    activeFeature = null;
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function rowToneClass(f: CategorizedFeature): string {
    return `row-tone--${f.status}`;
  }

  function statusLabel(f: CategorizedFeature): string {
    switch (f.status) {
      case 'core':     return 'CORE';
      case 'extended': return 'EXT';
      case 'draft':    return 'DRAFT';
      case 'legacy':   return 'LEGACY';
      case 'ircv3':    return 'IRCV3';
      case 'server':   return 'CUSTOM';
    }
  }

  function formatValueInline(f: CategorizedFeature): string {
    if (f.isFlag) return '—';
    if (f.catalog?.kind === 'enum') {
      const allowed = (f.catalog.values ?? []).includes(f.value);
      return f.value + (allowed ? '' : '  ⚠');
    }
    // Long values truncate and the full text is in the tooltip
    if (f.value.length > 36) return f.value.slice(0, 33) + '…';
    return f.value;
  }

  /** Title pulled from NETWORK= or fallback. */
  const panelTitle = $derived(
    stats.network && stats.network.value ? stats.network.value : titleFallback
  );
</script>

<section
  class="server-features-panel"
  class:server-features-panel--dense={dense}
  class:server-features-panel--collapsed={panelCollapsed}
  data-testid="server-features-panel"
  aria-labelledby="server-features-panel-title"
>
  <header class="server-features-panel__head">
    <button
      type="button"
      class="server-features-panel__head-toggle"
      onclick={togglePanel}
      aria-expanded={!panelCollapsed}
      aria-controls="server-features-panel-body"
      aria-label={panelCollapsed ? 'Expand Server features' : 'Collapse Server features'}
      data-testid="server-features-panel-toggle"
    >
      <div class="server-features-panel__head-row">
        <span class="server-features-panel__eyebrow" id="server-features-panel-title">Server features</span>
        <span class="server-features-panel__title">{panelTitle}</span>
        {#if stats.ircd}
          <span
            class="server-features-panel__ircd"
            data-testid="server-features-panel-ircd"
            title="Server software identifier"
          >
            <span class="server-features-panel__ircd-kicker">IRCD</span>
            <span class="server-features-panel__ircd-val">{stats.ircd.value}</span>
          </span>
        {/if}
        <span class="server-features-panel__chevron" aria-hidden="true">▾</span>
      </div>
      <div class="server-features-panel__stats" aria-label="Server feature statistics">
        <span class="server-features-panel__stat" data-testid="sfp-stat-total">
          <span class="server-features-panel__stat-num">{stats.total}</span>
          <span class="server-features-panel__stat-label">features</span>
        </span>
        <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
        <span class="server-features-panel__stat">
          <span class="server-features-panel__stat-num">{stats.categories}</span>
          <span class="server-features-panel__stat-label">categories</span>
        </span>
        <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
        <span class="server-features-panel__stat" data-testid="sfp-stat-ircv3">
          <span class="server-features-panel__stat-num server-features-panel__stat-num--ircv3">{stats.ircv3}</span>
          <span class="server-features-panel__stat-label">IRCv3</span>
        </span>
        {#if stats.core > 0}
          <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
          <span class="server-features-panel__stat">
            <span class="server-features-panel__stat-num server-features-panel__stat-num--core">{stats.core}</span>
            <span class="server-features-panel__stat-label">core</span>
          </span>
        {/if}
        {#if stats.serverSpecific > 0}
          <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
          <span class="server-features-panel__stat">
            <span class="server-features-panel__stat-num server-features-panel__stat-num--server">{stats.serverSpecific}</span>
            <span class="server-features-panel__stat-label">custom</span>
          </span>
        {/if}
        {#if stats.legacy > 0}
          <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
          <span class="server-features-panel__stat">
            <span class="server-features-panel__stat-num server-features-panel__stat-num--legacy">{stats.legacy}</span>
            <span class="server-features-panel__stat-label">legacy</span>
          </span>
        {/if}
      </div>
    </button>

  </header>

  {#if !isupport || stats.total === 0}
    <p class="server-features-panel__empty">
      No ISUPPORT tokens have been received yet — connect to a server to see its feature inventory.
    </p>
  {:else if !panelCollapsed}
    <div
      class="server-features-panel__categories"
      data-testid="server-features-panel-categories"
      id="server-features-panel-body"
    >
      {#each groups as group (group.category.id)}
        {@const isCollapsed = !!collapsed[group.category.id]}
        <details
          class="server-features-panel__cat"
          class:server-features-panel__cat--collapsed={isCollapsed}
          data-testid="server-features-panel-cat"
          data-category={group.category.id}
          open={!isCollapsed}
          ontoggle={(e) => {
            const shouldOpen = (e.currentTarget as HTMLDetailsElement).open;
            if (shouldOpen === !isCollapsed) return;
            toggleCategory(group.category.id);
          }}
        >
          <summary
            class="server-features-panel__cat-head"
            aria-expanded={!isCollapsed}
            aria-controls={`server-features-panel-cat-body-${group.category.id}`}
          >
            <span class="server-features-panel__cat-icon" aria-hidden="true">{group.category.icon}</span>
            <span class="server-features-panel__cat-titles">
              <span class="server-features-panel__cat-eyebrow">{group.category.name}</span>
              <span class="server-features-panel__cat-title">{group.category.title}</span>
              <span class="server-features-panel__cat-blurb">{group.category.blurb}</span>
            </span>
            <span class="server-features-panel__cat-count" aria-label={`${group.features.length} features`}>
              {group.features.length}
            </span>
          </summary>

          {#if !isCollapsed}
          <ul
              class="server-features-panel__rows"
              id={`server-features-panel-cat-body-${group.category.id}`}
              data-testid="server-features-panel-rows"
            >
              {#each group.features as f (f.key)}
                {@const toneCls = rowToneClass(f)}
                <li class="server-features-panel__row {toneCls}" data-testid="server-features-panel-row">
                  <button
                    type="button"
                    class="server-features-panel__row-btn"
                    onclick={() => openFeature(f)}
                    data-key={f.key}
                    data-status={f.status}
                  >
                    <span class="server-features-panel__row-status" data-testid="row-status">{statusLabel(f)}</span>
                    <span class="server-features-panel__row-key" data-testid="row-key">{f.rawKey}</span>
                    <span class="server-features-panel__row-eq" aria-hidden="true">{f.isFlag ? '' : '='}</span>
                    <span
                      class="server-features-panel__row-value"
                      class:server-features-panel__row-value--flag={f.isFlag}
                      title={f.value || ''}
                    >
                      {formatValueInline(f)}
                    </span>
                    <span class="server-features-panel__row-blurb">
                      {f.catalog?.short ?? 'Server-specific extension. Click to inspect.'}
                    </span>
                    <span class="server-features-panel__row-caret" aria-hidden="true">›</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </details>
      {/each}
    </div>
  {/if}

  <!-- ── Drawer (only mounted when a feature is active) ── -->
  {#if activeFeature}
    {#key activeFeature.key + ':' + activeFeature.value}
      <IsupportDetailDrawer feature={activeFeature} onClose={closeFeature} />
    {/key}
  {/if}
</section>

<style>
  .server-features-panel {
    background: var(--fiber-paper, #0e131a);
    border: 1px solid var(--fiber-line, #1a212b);
    border-radius: 6px;
    color: var(--fiber-cloud, #c8d2dd);
    overflow: hidden;
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .server-features-panel--dense {
    background: transparent;
    border: 0;
    border-top: 1px solid var(--fiber-line, #1a212b);
    border-radius: 0;
  }

  /* ── Header ─────────────────────────────────────────────────────── */
  .server-features-panel__head {
    border-bottom: 1px solid var(--fiber-line, #1a212b);
    background: linear-gradient(
      180deg,
      var(--fiber-blue-soft, rgba(103, 232, 249, 0.04)) 0%,
      transparent 100%
    );
  }
  .server-features-panel--dense .server-features-panel__head {
    background: transparent;
    border-bottom-color: var(--fiber-line, #1a212b);
  }
  .server-features-panel--collapsed .server-features-panel__head {
    border-bottom-color: transparent;
    background: transparent;
  }

  /* The whole header is a clickable toggle — wrap the head-row + stats in a
   * single button so the user can collapse/expand by clicking anywhere in
   * the title strip. Pointer + keyboard accessible. */
  .server-features-panel__head-toggle {
    display: block;
    width: 100%;
    padding: 14px 18px 14px;
    background: transparent;
    border: 0;
    color: inherit;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
  }
  .server-features-panel--dense .server-features-panel__head-toggle {
    padding: 8px 14px;
  }
  .server-features-panel__head-toggle:hover {
    background: rgba(255, 255, 255, 0.02);
  }
  .server-features-panel__head-toggle:focus-visible {
    outline: 2px solid var(--fiber-blue, #67e8f9);
    outline-offset: -2px;
  }

  /* Chevron indicator at the right of the head-row. Rotates 180° when
   * the panel is collapsed. Using ▾ (▼) so a screen reader doesn't have
   * to deal with CSS-only state — the aria-expanded attribute on the
   * toggle button carries the actual state for assistive tech. */
  .server-features-panel__chevron {
    margin-left: auto;
    flex-shrink: 0;
    font-size: 12px;
    color: var(--fiber-mist, #4d5867);
    transition: transform 150ms ease;
    width: 14px;
    text-align: center;
  }
  .server-features-panel--collapsed .server-features-panel__chevron {
    transform: rotate(-90deg);
  }

  .server-features-panel--dense .server-features-panel__head-row {
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .server-features-panel--dense .server-features-panel__title { display: none; }
  .server-features-panel--dense .server-features-panel__cat-head { padding: 7px 14px; gap: 8px; }
  .server-features-panel--dense .server-features-panel__cat-icon { font-size: 11px; }
  .server-features-panel--dense .server-features-panel__cat-blurb { display: none; }
  .server-features-panel--dense .server-features-panel__cat-titles { gap: 2px; }
  .server-features-panel--dense .server-features-panel__cat-eyebrow { font-size: 9px; }
  .server-features-panel--dense .server-features-panel__cat-title { font-size: 11px; }
  .server-features-panel--dense .server-features-panel__row-blurb { display: none; }
  .server-features-panel--dense .server-features-panel__row-caret { color: var(--fiber-mist, #4d5867); font-size: 10px; }
  .server-features-panel--dense .server-features-panel__row-status { padding: 1px 4px; font-size: 8px; letter-spacing: 0.06em; }
  .server-features-panel--dense .server-features-panel__eyebrow { font-size: 9px; letter-spacing: 0.12em; }
  .server-features-panel--dense .server-features-panel__eyebrow::before { width: 10px; }

  .server-features-panel__head-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .server-features-panel__eyebrow {
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--fiber-blue, #67e8f9);
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .server-features-panel__eyebrow::before {
    content: "";
    width: 16px;
    height: 1px;
    background: var(--fiber-blue, #67e8f9);
    box-shadow: 0 0 6px var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
  }

  .server-features-panel__title {
    font-family: var(--font-display, var(--font-sans, sans-serif));
    font-size: 18px;
    font-weight: 600;
    color: var(--fiber-snow, #ecf2f8);
    letter-spacing: -0.01em;
  }

  .server-features-panel__ircd {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px 3px 6px;
    border: 1px solid var(--fiber-line, #1a212b);
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.18);
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 11px;
  }
  .server-features-panel__ircd-kicker {
    font-size: 9px;
    font-weight: 700;
    color: var(--fiber-mist, #4d5867);
    letter-spacing: 0.1em;
  }
  .server-features-panel__ircd-val {
    color: var(--fiber-cloud, #c8d2dd);
  }

  /* ── Stats row ─────────────────────────────────────────────────── */
  .server-features-panel__stats {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 6px;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 11.5px;
    color: var(--fiber-fog, #8b96a4);
    margin-bottom: 10px;
  }
  .server-features-panel__stat {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }
  .server-features-panel__stat-num {
    font-weight: 700;
    color: var(--fiber-snow, #ecf2f8);
    font-variant-numeric: tabular-nums;
  }
  .server-features-panel__stat-num--ircv3 { color: #f472b6; }
  .server-features-panel__stat-num--core   { color: #34d399; }
  .server-features-panel__stat-num--server { color: var(--fiber-fog, #8b96a4); }
  .server-features-panel__stat-num--legacy { color: #a78bfa; }
  .server-features-panel__stat-label {
    color: var(--fiber-mist, #4d5867);
    font-size: 10.5px;
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }
  .server-features-panel--dense .server-features-panel__stats {
    margin-bottom: 0;
    font-size: 10px;
    gap: 3px 6px;
    color: var(--fiber-mist, #4d5867);
  }
  .server-features-panel--dense .server-features-panel__stat-num { color: var(--fiber-fog, #8b96a4); font-weight: 600; }
  .server-features-panel--dense .server-features-panel__stat-num--ircv3,
  .server-features-panel--dense .server-features-panel__stat-num--core,
  .server-features-panel--dense .server-features-panel__stat-num--server,
  .server-features-panel--dense .server-features-panel__stat-num--legacy { color: var(--fiber-fog, #8b96a4); }
  .server-features-panel__empty {
    padding: 22px 18px;
    color: var(--fiber-mist, #4d5867);
    font-size: 12.5px;
    text-align: center;
    font-style: italic;
  }

  /* ── Categories ────────────────────────────────────────────────── */
  .server-features-panel__categories {
    padding: 0;
  }

  .server-features-panel__cat {
    border-top: 1px solid var(--fiber-line, #1a212b);
  }
  .server-features-panel__cat:first-child {
    border-top: 0;
  }

  .server-features-panel__cat-head {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 18px;
    background: transparent;
    border: 0;
    border-bottom: 1px dashed transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    transition: background 100ms ease;
    font-family: inherit;
  }
  .server-features-panel__cat-head:hover {
    background: rgba(255, 255, 255, 0.02);
  }
  .server-features-panel__cat-head:focus-visible {
    outline: 2px solid var(--fiber-blue, #67e8f9);
    outline-offset: -2px;
  }
  .server-features-panel--dense .server-features-panel__cat-head {
    padding: 6px 12px;
    gap: 8px;
  }

  .server-features-panel--dense .server-features-panel__cat-icon {
    width: 22px;
    height: 22px;
    font-size: 11px;
  }

  .server-features-panel--dense .server-features-panel__cat-titles {
    gap: 0;
  }

  .server-features-panel--dense .server-features-panel__cat-eyebrow {
    font-size: 9px;
  }

  .server-features-panel--dense .server-features-panel__cat-title {
    font-size: 12.5px;
  }

  .server-features-panel--dense .server-features-panel__cat-blurb {
    display: none;
  }

  .server-features-panel--dense .server-features-panel__cat-count {
    min-width: 24px;
    padding: 1px 6px;
  }
  .server-features-panel__cat-icon {
    flex-shrink: 0;
    width: 28px;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(103, 232, 249, 0.06);
    border: 1px solid rgba(103, 232, 249, 0.18);
    color: var(--fiber-blue, #67e8f9);
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 12px;
    font-weight: 700;
  }

  .server-features-panel__cat-titles {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .server-features-panel__cat-eyebrow {
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 10px;
    color: var(--fiber-mist, #4d5867);
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }
  .server-features-panel__cat-title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--fiber-snow, #ecf2f8);
    letter-spacing: -0.005em;
  }
  .server-features-panel__cat-blurb {
    font-size: 11.5px;
    color: var(--fiber-fog, #8b96a4);
    line-height: 1.45;
    margin-top: 1px;
  }

  .server-features-panel__cat-count {
    flex-shrink: 0;
    min-width: 28px;
    padding: 2px 8px;
    text-align: center;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--fiber-cloud, #c8d2dd);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--fiber-line, #1a212b);
    border-radius: 999px;
  }
  .server-features-panel__cat--collapsed .server-features-panel__cat-count {
    background: rgba(103, 232, 249, 0.08);
    border-color: rgba(103, 232, 249, 0.18);
    color: var(--fiber-blue, #67e8f9);
  }

  /* ── Rows ──────────────────────────────────────────────────────── */
  .server-features-panel__rows {
    list-style: none;
    margin: 0;
    padding: 4px 0 8px;
  }

  .server-features-panel__row-btn {
    display: grid;
    grid-template-columns: 54px minmax(72px, max-content) 8px minmax(120px, 1fr) minmax(0, 2fr) 14px;
    grid-template-areas: "status key eq value blurb caret";
    align-items: baseline;
    column-gap: 8px;
    width: 100%;
    padding: 7px 14px 7px 22px;
    background: transparent;
    border: 0;
    border-top: 1px solid transparent;
    border-bottom: 1px solid transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    transition: background 100ms ease, border-color 100ms ease;
  }
  .server-features-panel--dense .server-features-panel__row-btn {
    padding: 6px 12px 6px 14px;
    grid-template-columns: 52px minmax(72px, max-content) 8px minmax(80px, 1fr) minmax(0, 1.5fr) 12px;
    column-gap: 8px;
  }
  .server-features-panel__row-btn:hover {
    background: rgba(103, 232, 249, 0.04);
    border-bottom-color: var(--fiber-line, #1a212b);
  }
  .server-features-panel__row-btn:focus-visible {
    outline: 2px solid var(--fiber-blue, #67e8f9);
    outline-offset: -2px;
  }

  .server-features-panel__row-status {
    grid-area: status;
    justify-self: start;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 2px 5px;
    border-radius: 3px;
    border: 1px solid currentColor;
    align-self: center;
  }

  .server-features-panel__row-key {
    grid-area: key;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--fiber-blue, #67e8f9);
    letter-spacing: -0.005em;
    word-break: break-all;
  }
  .server-features-panel__row-eq {
    grid-area: eq;
    color: var(--fiber-mist, #4d5867);
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
  }
  .server-features-panel__row-value {
    grid-area: value;
    font-family: var(--font-mono-fiber, ui-monospace, monospace);
    font-size: 12px;
    color: var(--fiber-amber, #fbbf24);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .server-features-panel__row-value--flag {
    color: var(--fiber-blue, #67e8f9);
    opacity: 0.65;
    font-style: italic;
  }
  .server-features-panel__row-blurb {
    grid-area: blurb;
    font-size: 11.5px;
    color: var(--fiber-fog, #8b96a4);
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    align-self: center;
  }
  .server-features-panel__row-caret {
    grid-area: caret;
    justify-self: end;
    color: var(--fiber-mist, #4d5867);
    font-size: 14px;
    line-height: 1;
    align-self: center;
    transition: transform 120ms ease, color 120ms ease;
  }
  .server-features-panel__row-btn:hover .server-features-panel__row-caret {
    color: var(--fiber-blue, #67e8f9);
    transform: translateX(2px);
  }

  /* Better grid on narrow widths — fold value + blurb onto two rows */
  @media (max-width: 720px) {
    .server-features-panel__row-btn {
      grid-template-columns: 48px max-content 1fr 12px;
      grid-template-areas:
        "status key   blurb caret"
        ".      value blurb caret";
      row-gap: 2px;
    }
    .server-features-panel__row-eq { display: none; }
  }

  /* ── Row-tone variants (status badge colors + row left-edge accent) ── */
  .row-tone--core     .server-features-panel__row-status { color: #34d399; background: rgba(52, 211, 153, 0.10); }
  .row-tone--extended .server-features-panel__row-status { color: var(--fiber-blue, #67e8f9); background: rgba(103, 232, 249, 0.10); }
  .row-tone--draft    .server-features-panel__row-status { color: #fbbf24; background: rgba(251, 191, 36, 0.10); }
  .row-tone--legacy   .server-features-panel__row-status { color: #a78bfa; background: rgba(167, 139, 250, 0.10); }
  .row-tone--ircv3    .server-features-panel__row-status { color: #f472b6; background: rgba(244, 114, 182, 0.10); }
  .row-tone--server   .server-features-panel__row-status { color: var(--fiber-fog, #8b96a4); background: rgba(139, 150, 164, 0.10); }

  /* Left-edge accent stripe on each row — 1px subtle for catalog rows,
     no stripe for server-specific rows. The grid is already tight so we
     use a left inset on the button rather than absolute-positioned stripe
     to keep markup simple. */
  .row-tone--core .server-features-panel__row-btn     { box-shadow: inset 2px 0 0 #34d39940; }
  .row-tone--extended .server-features-panel__row-btn { box-shadow: inset 2px 0 0 rgba(103, 232, 249, 0.4); }
  .row-tone--ircv3 .server-features-panel__row-btn    { box-shadow: inset 2px 0 0 rgba(244, 114, 182, 0.4); }
  .row-tone--draft .server-features-panel__row-btn    { box-shadow: inset 2px 0 0 rgba(251, 191, 36, 0.4); }
  .row-tone--legacy .server-features-panel__row-btn   { box-shadow: inset 2px 0 0 rgba(167, 139, 250, 0.4); }
  .row-tone--server .server-features-panel__row-btn   { box-shadow: inset 2px 0 0 rgba(139, 150, 164, 0.25); }
</style>
