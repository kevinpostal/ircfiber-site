<script lang="ts">
  /*
   * CapabilitiesPanel — categorized overview of IRCv3 CAP LS tokens.
   *
   * Mirrors ServerFeaturesPanel but for CAP negotiation (the "Notice"
   * section's capability dump). Groups caps by purpose (Auth, Messaging,
   * Draft, …) and makes each row clickable to open the CapDetailDrawer
   * (visual structure matches https://ircv3.net/specs/extensions/*).
   */
  import {
    categorizeCaps,
    capStats,
    type CategorizedCap,
    type CategorizedCapGroup,
  } from '../lib/capCategorize';
  import CapDetailDrawer from './CapDetailDrawer.svelte';

  interface Props {
    caps?: Record<string, string> | null;
    dense?: boolean;
    titleFallback?: string;
  }

  let { caps, dense = false, titleFallback = 'Capabilities' }: Props = $props();

  const groups = $derived<CategorizedCapGroup[]>(
    caps ? categorizeCaps(caps) : []
  );
  const stats = $derived(capStats(groups));

  function loadCollapsed(): boolean {
    try {
      const raw = localStorage.getItem('ircfiber:capabilitiesCollapsed');
      if (raw === null) return true;
      return JSON.parse(raw) === true;
    } catch {
      return true;
    }
  }
  function saveCollapsed(v: boolean): void {
    try {
      localStorage.setItem('ircfiber:capabilitiesCollapsed', JSON.stringify(v));
    } catch {}
  }
  let panelCollapsed = $state<boolean>(dense ? true : loadCollapsed());
  $effect(() => { saveCollapsed(panelCollapsed); });
  function togglePanel(): void { panelCollapsed = !panelCollapsed; }

  let collapsed = $state<Record<string, boolean>>({});
  $effect(() => {
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

  let activeFeature = $state<CategorizedCap | null>(null);
  function openFeature(f: CategorizedCap): void { activeFeature = f; }
  function closeFeature(): void { activeFeature = null; }

  function rowToneClass(f: CategorizedCap): string {
    return `row-tone--${f.status}`;
  }

  function statusLabel(f: CategorizedCap): string {
    switch (f.status) {
      case 'ircv3':    return 'IRCV3';
      case 'draft':    return 'DRAFT';
      case 'vendor':   return 'VENDOR';
      case 'extended': return 'EXT';
      case 'core':     return 'CORE';
      case 'server':   return 'CUSTOM';
      default:         return (f.status as string).toUpperCase();
    }
  }

  function formatValueInline(f: CategorizedCap): string {
    if (f.isFlag) return '—';
    if (f.value.length > 36) return f.value.slice(0, 33) + '…';
    return f.value;
  }

  const panelTitle = $derived(titleFallback);
</script>

<section
  class="server-features-panel"
  class:server-features-panel--dense={dense}
  class:server-features-panel--collapsed={panelCollapsed}
  data-testid="capabilities-panel"
  aria-labelledby="capabilities-panel-title"
>
  <header class="server-features-panel__head">
    <button
      type="button"
      class="server-features-panel__head-toggle"
      onclick={togglePanel}
      aria-expanded={!panelCollapsed}
      aria-controls="capabilities-panel-body"
      aria-label={panelCollapsed ? 'Expand Capabilities' : 'Collapse Capabilities'}
      data-testid="capabilities-panel-toggle"
    >
      <div class="server-features-panel__head-row">
        <span class="server-features-panel__eyebrow" id="capabilities-panel-title">Capabilities</span>
        <span class="server-features-panel__title">{panelTitle}</span>
        <span class="server-features-panel__chevron" aria-hidden="true">▾</span>
      </div>
      <div class="server-features-panel__stats" aria-label="Capability statistics">
        <span class="server-features-panel__stat" data-testid="cap-stat-total">
          <span class="server-features-panel__stat-num">{stats.total}</span>
          <span class="server-features-panel__stat-label">caps</span>
        </span>
        <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
        <span class="server-features-panel__stat">
          <span class="server-features-panel__stat-num">{stats.categories}</span>
          <span class="server-features-panel__stat-label">categories</span>
        </span>
        {#if stats.ircv3 > 0}
          <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
          <span class="server-features-panel__stat" data-testid="cap-stat-ircv3">
            <span class="server-features-panel__stat-num server-features-panel__stat-num--ircv3">{stats.ircv3}</span>
            <span class="server-features-panel__stat-label">IRCv3</span>
          </span>
        {/if}
        {#if stats.draft > 0}
          <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
          <span class="server-features-panel__stat">
            <span class="server-features-panel__stat-num server-features-panel__stat-num--draft">{stats.draft}</span>
            <span class="server-features-panel__stat-label">draft</span>
          </span>
        {/if}
        {#if stats.vendor > 0}
          <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
          <span class="server-features-panel__stat">
            <span class="server-features-panel__stat-num server-features-panel__stat-num--vendor">{stats.vendor}</span>
            <span class="server-features-panel__stat-label">vendor</span>
          </span>
        {/if}
        {#if stats.serverSpecific > 0}
          <span class="server-features-panel__stat-sep" aria-hidden="true">·</span>
          <span class="server-features-panel__stat">
            <span class="server-features-panel__stat-num server-features-panel__stat-num--server">{stats.serverSpecific}</span>
            <span class="server-features-panel__stat-label">custom</span>
          </span>
        {/if}
      </div>
    </button>
  </header>

  {#if !caps || stats.total === 0}
    <p class="server-features-panel__empty">
      No IRCv3 capabilities have been advertised yet — connect to a server to see its CAP list.
    </p>
  {:else if !panelCollapsed}
    <div
      class="server-features-panel__categories"
      data-testid="capabilities-panel-categories"
      id="capabilities-panel-body"
    >
      {#each groups as group (group.category.id)}
        {@const isCollapsed = !!collapsed[group.category.id]}
        <details
          class="server-features-panel__cat"
          class:server-features-panel__cat--collapsed={isCollapsed}
          data-testid="capabilities-panel-cat"
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
            aria-controls={`capabilities-panel-cat-body-${group.category.id}`}
          >
            <span class="server-features-panel__cat-icon" aria-hidden="true">{group.category.icon}</span>
            <span class="server-features-panel__cat-titles">
              <span class="server-features-panel__cat-eyebrow">{group.category.name}</span>
              <span class="server-features-panel__cat-title">{group.category.title}</span>
              <span class="server-features-panel__cat-blurb">{group.category.blurb}</span>
            </span>
            <span class="server-features-panel__cat-count" aria-label={`${group.caps.length} caps`}>
              {group.caps.length}
            </span>
          </summary>

          {#if !isCollapsed}
          <ul
              class="server-features-panel__rows"
              id={`capabilities-panel-cat-body-${group.category.id}`}
              data-testid="capabilities-panel-rows"
            >
              {#each group.caps as f (f.key)}
                {@const toneCls = rowToneClass(f)}
                <li class="server-features-panel__row {toneCls}" data-testid="capabilities-panel-row">
                  <button
                    type="button"
                    class="server-features-panel__row-btn"
                    onclick={() => openFeature(f)}
                    data-key={f.key}
                    data-status={f.status}
                  >
                    <span class="server-features-panel__row-status" data-testid="cap-row-status">{statusLabel(f)}</span>
                    <span class="server-features-panel__row-key" data-testid="cap-row-key">{f.rawKey}</span>
                    <span class="server-features-panel__row-eq" aria-hidden="true">{f.isFlag ? '' : '='}</span>
                    <span
                      class="server-features-panel__row-value"
                      class:server-features-panel__row-value--flag={f.isFlag}
                      title={f.value || ''}
                    >
                      {formatValueInline(f)}
                    </span>
                    <span class="server-features-panel__row-blurb">
                      {f.catalog?.short ?? 'Server-specific capability. Click to inspect.'}
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

  {#if activeFeature}
    {#key activeFeature.key + ':' + activeFeature.value}
      <CapDetailDrawer feature={activeFeature} onClose={closeFeature} />
    {/key}
  {/if}
</section>

<style>
  /* Reuse ServerFeaturesPanel CSS — duplicate the visual block so this
     panel is self-contained even when the server-features file changes.
     The class names are intentionally shared (.server-features-panel*)
     so a single stylesheet covers both panels. */
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
  .server-features-panel__head {
    border-bottom: 1px solid var(--fiber-line, #1a212b);
    background: linear-gradient(180deg, var(--fiber-blue-soft, rgba(103, 232, 249, 0.04)) 0%, transparent 100%);
  }
  .server-features-panel--dense .server-features-panel__head { background: transparent; }
  .server-features-panel--collapsed .server-features-panel__head { border-bottom-color: transparent; background: transparent; }
  .server-features-panel__head-toggle {
    display: block; width: 100%; padding: 14px 18px 14px; background: transparent; border: 0; color: inherit; text-align: left; cursor: pointer; font-family: inherit;
  }
  .server-features-panel--dense .server-features-panel__head-toggle { padding: 8px 14px; }
  .server-features-panel__head-toggle:hover { background: rgba(255,255,255,0.02); }
  .server-features-panel__head-toggle:focus-visible { outline: 2px solid var(--fiber-blue, #67e8f9); outline-offset: -2px; }
  .server-features-panel__chevron { margin-left: auto; flex-shrink: 0; font-size: 12px; color: var(--fiber-mist, #4d5867); transition: transform 150ms ease; width: 14px; text-align: center; }
  .server-features-panel--collapsed .server-features-panel__chevron { transform: rotate(-90deg); }
  .server-features-panel__head-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  .server-features-panel--dense .server-features-panel__head-row { align-items: center; gap: 8px; margin-bottom: 4px; }
  .server-features-panel__eyebrow {
    font-family: var(--font-mono-fiber, ui-monospace, monospace); font-size: 10px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: var(--fiber-blue, #67e8f9); display: inline-flex; align-items: center; gap: 8px;
  }
  .server-features-panel__eyebrow::before {
    content: ""; width: 16px; height: 1px; background: var(--fiber-blue, #67e8f9); box-shadow: 0 0 6px var(--fiber-blue-glow, rgba(103,232,249,0.35));
  }
  .server-features-panel__title { font-family: var(--font-display, var(--font-sans, sans-serif)); font-size: 18px; font-weight: 600; color: var(--fiber-snow, #ecf2f8); letter-spacing: -0.01em; }
  .server-features-panel--dense .server-features-panel__title { display: none; }
  .server-features-panel__stats { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 6px; font-family: var(--font-mono-fiber, ui-monospace, monospace); font-size: 11.5px; color: var(--fiber-fog, #8b96a4); margin-bottom: 10px; }
  .server-features-panel--dense .server-features-panel__stats { margin-bottom: 0; font-size: 10px; gap: 3px 6px; color: var(--fiber-mist, #4d5867); }
  .server-features-panel__stat { display: inline-flex; align-items: baseline; gap: 4px; }
  .server-features-panel__stat-num { font-weight: 700; color: var(--fiber-snow, #ecf2f8); font-variant-numeric: tabular-nums; }
  .server-features-panel__stat-num--ircv3 { color: #f472b6; }
  .server-features-panel__stat-num--draft { color: #fbbf24; }
  .server-features-panel__stat-num--vendor { color: #c9a0ff; }
  .server-features-panel__stat-num--server { color: var(--fiber-fog, #8b96a4); }
  .server-features-panel__stat-label { color: var(--fiber-mist, #4d5867); font-size: 10.5px; text-transform: lowercase; letter-spacing: 0.04em; }
  .server-features-panel__empty { padding: 22px 18px; color: var(--fiber-mist, #4d5867); font-size: 12.5px; text-align: center; font-style: italic; }
  .server-features-panel__categories { padding: 0; }
  .server-features-panel__cat { border-top: 1px solid var(--fiber-line, #1a212b); }
  .server-features-panel__cat:first-child { border-top: 0; }
  .server-features-panel__cat-head {
    display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 18px; background: transparent; border: 0; color: inherit; cursor: pointer; text-align: left; transition: background 100ms ease; font-family: inherit;
  }
  .server-features-panel__cat-head:hover { background: rgba(255,255,255,0.02); }
  .server-features-panel__cat-head:focus-visible { outline: 2px solid var(--fiber-blue, #67e8f9); outline-offset: -2px; }
  .server-features-panel--dense .server-features-panel__cat-head { padding: 6px 12px; gap: 8px; }
  .server-features-panel__cat-icon {
    flex-shrink: 0; width: 28px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; background: rgba(103,232,249,0.06); border: 1px solid rgba(103,232,249,0.18); color: var(--fiber-blue, #67e8f9); font-family: var(--font-mono-fiber, ui-monospace, monospace); font-size: 12px; font-weight: 700;
  }
  .server-features-panel--dense .server-features-panel__cat-icon { width: 22px; height: 22px; font-size: 11px; }
  .server-features-panel__cat-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .server-features-panel--dense .server-features-panel__cat-titles { gap: 0; }
  .server-features-panel__cat-eyebrow { font-family: var(--font-mono-fiber, ui-monospace, monospace); font-size: 10px; color: var(--fiber-mist, #4d5867); text-transform: uppercase; letter-spacing: 0.14em; }
  .server-features-panel__cat-title { font-size: 13.5px; font-weight: 600; color: var(--fiber-snow, #ecf2f8); letter-spacing: -0.005em; }
  .server-features-panel__cat-blurb { font-size: 11.5px; color: var(--fiber-fog, #8b96a4); line-height: 1.45; margin-top: 1px; }
  .server-features-panel--dense .server-features-panel__cat-blurb { display: none; }
  .server-features-panel--dense .server-features-panel__cat-eyebrow { font-size: 9px; }
  .server-features-panel--dense .server-features-panel__cat-title { font-size: 11px; }
  .server-features-panel__cat-count {
    flex-shrink: 0; min-width: 28px; padding: 2px 8px; text-align: center; font-family: var(--font-mono-fiber, ui-monospace, monospace); font-size: 11.5px; font-weight: 600; color: var(--fiber-cloud, #c8d2dd); background: rgba(255,255,255,0.04); border: 1px solid var(--fiber-line, #1a212b); border-radius: 999px;
  }
  .server-features-panel--dense .server-features-panel__cat-count { min-width: 24px; padding: 1px 6px; }
  .server-features-panel__rows { list-style: none; margin: 0; padding: 4px 0 8px; }
  .server-features-panel__row-btn {
    display: grid; grid-template-columns: 54px minmax(72px, max-content) 8px minmax(120px, 1fr) minmax(0, 2fr) 14px; grid-template-areas: "status key eq value blurb caret"; align-items: baseline; column-gap: 8px; width: 100%; padding: 7px 14px 7px 22px; background: transparent; border: 0; border-top: 1px solid transparent; border-bottom: 1px solid transparent; color: inherit; text-align: left; cursor: pointer; font-family: inherit; transition: background 100ms ease, border-color 100ms ease;
  }
  .server-features-panel--dense .server-features-panel__row-btn { padding: 6px 12px 6px 14px; grid-template-columns: 52px minmax(72px, max-content) 8px minmax(80px, 1fr) minmax(0, 1.5fr) 12px; column-gap: 8px; }
  .server-features-panel__row-btn:hover { background: rgba(103,232,249,0.04); border-bottom-color: var(--fiber-line, #1a212b); }
  .server-features-panel__row-btn:focus-visible { outline: 2px solid var(--fiber-blue, #67e8f9); outline-offset: -2px; }
  .server-features-panel__row-status { grid-area: status; justify-self: start; font-family: var(--font-mono-fiber, ui-monospace, monospace); font-size: 9px; font-weight: 700; letter-spacing: 0.08em; padding: 2px 5px; border-radius: 3px; border: 1px solid currentColor; align-self: center; }
  .server-features-panel__row-key { grid-area: key; font-family: var(--font-mono-fiber, ui-monospace, monospace); font-size: 12.5px; font-weight: 600; color: var(--fiber-blue, #67e8f9); letter-spacing: -0.005em; word-break: break-all; }
  .server-features-panel__row-eq { grid-area: eq; color: var(--fiber-mist, #4d5867); font-family: var(--font-mono-fiber, ui-monospace, monospace); }
  .server-features-panel__row-value { grid-area: value; font-family: var(--font-mono-fiber, ui-monospace, monospace); font-size: 12px; color: var(--fiber-amber, #fbbf24); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .server-features-panel__row-value--flag { color: var(--fiber-blue, #67e8f9); opacity: 0.65; font-style: italic; }
  .server-features-panel__row-blurb { grid-area: blurb; font-size: 11.5px; color: var(--fiber-fog, #8b96a4); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; align-self: center; }
  .server-features-panel--dense .server-features-panel__row-blurb { display: none; }
  .server-features-panel__row-caret { grid-area: caret; justify-self: end; color: var(--fiber-mist, #4d5867); font-size: 14px; line-height: 1; align-self: center; transition: transform 120ms ease, color 120ms ease; }
  .server-features-panel__row-btn:hover .server-features-panel__row-caret { color: var(--fiber-blue, #67e8f9); transform: translateX(2px); }
  @media (max-width: 720px) {
    .server-features-panel__row-btn { grid-template-columns: 48px max-content 1fr 12px; grid-template-areas: "status key   blurb caret" ".      value blurb caret"; row-gap: 2px; }
    .server-features-panel__row-eq { display: none; }
  }
  .row-tone--core .server-features-panel__row-status { color: #34d399; background: rgba(52,211,153,0.10); }
  .row-tone--extended .server-features-panel__row-status { color: var(--fiber-blue, #67e8f9); background: rgba(103,232,249,0.10); }
  .row-tone--draft .server-features-panel__row-status { color: #fbbf24; background: rgba(251,191,36,0.10); }
  .row-tone--vendor .server-features-panel__row-status { color: #c9a0ff; background: rgba(201,160,255,0.10); }
  .row-tone--ircv3 .server-features-panel__row-status { color: #f472b6; background: rgba(244,114,182,0.10); }
  .row-tone--server .server-features-panel__row-status { color: var(--fiber-fog, #8b96a4); background: rgba(139,150,164,0.10); }
  .row-tone--core .server-features-panel__row-btn { box-shadow: inset 2px 0 0 #34d39940; }
  .row-tone--extended .server-features-panel__row-btn { box-shadow: inset 2px 0 0 rgba(103,232,249,0.4); }
  .row-tone--ircv3 .server-features-panel__row-btn { box-shadow: inset 2px 0 0 rgba(244,114,182,0.4); }
  .row-tone--draft .server-features-panel__row-btn { box-shadow: inset 2px 0 0 rgba(251,191,36,0.4); }
  .row-tone--vendor .server-features-panel__row-btn { box-shadow: inset 2px 0 0 rgba(201,160,255,0.4); }
  .row-tone--server .server-features-panel__row-btn { box-shadow: inset 2px 0 0 rgba(139,150,164,0.25); }
</style>
