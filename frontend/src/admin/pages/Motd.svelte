<script lang="ts">
  /**
   * MOTD page — the templates the IRC Fiber network greets users with.
   *
   * Two delivery paths, both fed from this list:
   *  - Per connect: the engine picks a random enabled template on every
   *    connect to irc.ircfiber.com (through IRC Fiber) and serves it as the
   *    MOTD instead of the ircd's file.
   *  - IRCd rotation: one random enabled template is written into the ircd's
   *    MOTD file and REHASHed on every save and hourly, so native clients
   *    connecting straight to the ircd cycle through the set too.
   *
   * Two editors: Raw (monospace textarea) and Builder (block recipe —
   * TheDraw/FIGlet banners, text, rules, key/value rows, frame). A recipe
   * is saved on the template so it reopens in the builder; "Generate
   * variants" renders the recipe N times with fresh random fonts and
   * replaces the variant group in one request.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import MotdBuilder from '../components/MotdBuilder.svelte';
  import MotdFontPicker from '../components/MotdFontPicker.svelte';
  import { ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { relative } from '../lib/format';
  import { parseIrcFormatting } from '../../lib/ircFormatting';
  import { utf8Length } from '../../lib/messageSplitter';
  import { type Recipe, defaultRecipe, parseRecipe, renderRecipe, fontsLabel } from '../lib/motdRecipe';
  import { insertBanner } from '../lib/motdInsert';
  import { type ArtFontKind, type FontEntry } from '../../lib/fontCatalog';
  import {
    fetchMotd, createMotd, updateMotd, deleteMotd, rotateMotd, batchMotd, pinMotd, unpinMotd, maxColumns,
    type MotdState, type MotdTemplate, type MotdTemplateInput,
  } from '../stores/motd';

  /** Bytes a 372 line may carry after `:server 372 <nick> :- `. */
  const LINE_BYTE_BUDGET = 450;

  let data = $state<MotdState | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);

  // Editor: `selectedId` is null for a new, unsaved template.
  let selectedId = $state<string | null>(null);
  let name = $state('');
  let body = $state('');
  let enabled = $state(true);
  let group = $state('');
  let mode = $state<'raw' | 'builder'>('raw');
  let recipe = $state<Recipe>(defaultRecipe());
  let dirty = $state(false);
  let saving = $state(false);
  let rotating = $state(false);
  let askDelete = $state<MotdTemplate | null>(null);
  let textarea = $state<HTMLTextAreaElement | null>(null);

  // Variants
  let variantCount = $state(6);
  let variantGroup = $state('');
  let generating = $state(false);

  // Banner font picker (raw mode). Mounted only while open: the TheDraw pack
  // is a single multi-megabyte asset fetched on the picker's first render.
  let fontOpen = $state(false);
  let fontKind = $state<ArtFontKind>('tdf');
  let fontSample = $state('IRC Fiber');
  let lastFont = $state<{ kind: ArtFontKind; name: string } | null>(null);


  const templates = $derived(data?.templates ?? []);
  const selected = $derived(templates.find((t) => t.id === selectedId) ?? null);
  const enabledCount = $derived(templates.filter((t) => t.enabled).length);
  const cols = $derived(maxColumns(body));
  const lineCount = $derived(body.replace(/\n+$/, '').split('\n').length);
  const tooWide = $derived(cols > 80);
  const bytes = $derived(maxLineBytes(body));
  /** Longest line in bytes (UTF-8, codes included) — what the IRC line limit sees. */
  function maxLineBytes(text: string): number {
    let max = 0;
    for (const line of text.split('\n')) max = Math.max(max, utf8Length(line));
    return max;
  }
  const tooLong = $derived(bytes > LINE_BYTE_BUDGET);
  const previewHtml = $derived(parseIrcFormatting(body || ' '));
  const groups = $derived.by(() => {
    const m = new Map<string, number>();
    for (const t of templates) if (t.group) m.set(t.group, (m.get(t.group) ?? 0) + 1);
    return m;
  });

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  function load(t: MotdTemplate | null) {
    selectedId = t?.id ?? null;
    name = t?.name ?? '';
    body = t?.body ?? '';
    enabled = t?.enabled ?? true;
    group = t?.group ?? '';
    const r = parseRecipe(t?.recipe ?? '');
    recipe = r ?? defaultRecipe();
    mode = r ? 'builder' : 'raw';
    variantGroup = t?.group || t?.name || '';
    dirty = false;
  }

  function select(t: MotdTemplate) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    load(t);
  }

  function startNew(withBuilder: boolean) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    load(null);
    name = withBuilder ? 'Built MOTD' : 'New template';
    variantGroup = name;
    mode = withBuilder ? 'builder' : 'raw';
    dirty = true;
  }

  async function refresh(spinner = data === null) {
    if (spinner) loading = true;
    loadError = null;
    try {
      data = await fetchMotd();
      if (selectedId === null && !dirty && data.templates.length) load(data.templates[0]);
    } catch (e) {
      loadError = errMsg(e);
    } finally {
      loading = false;
    }
  }
  onMount(() => { void refresh(); });

  /** Applies a write result; the server returns the whole list each time. */
  function apply(next: MotdState, okMsg: string) {
    data = next;
    if (next.rotation.error) toastError(`${okMsg} — ircd rotation failed: ${next.rotation.error}`);
    else toastSuccess(okMsg);
  }

  function input(): MotdTemplateInput {
    return {
      name: name.trim(), body, enabled, group,
      recipe: mode === 'builder' ? JSON.stringify($state.snapshot(recipe)) : '',
    };
  }

  async function save() {
    if (saving) return;
    const inp = input();
    if (!inp.name) { toastError('Name is required'); return; }
    if (tooLong) { toastError(`A line is ${bytes} bytes; keep every line under ${LINE_BYTE_BUDGET} bytes (fewer colour runs or a narrower banner).`); return; }
    saving = true;
    try {
      if (selectedId === null) {
        const next = await createMotd(inp);
        const created = next.templates.find((t) => !templates.some((p) => p.id === t.id));
        apply(next, 'Template created');
        if (created) load(created);
        else dirty = false;
      } else {
        apply(await updateMotd(selectedId, inp), 'Template saved');
        dirty = false;
      }
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      saving = false;
    }
  }

  /** Renders the recipe N times with fresh random picks → one variant group. */
  async function generateVariants() {
    if (generating) return;
    const g = variantGroup.trim();
    if (!g) { toastError('Group name is required'); return; }
    const n = Math.max(1, Math.min(50, variantCount));
    generating = true;
    try {
      const items: { name: string; body: string; enabled: boolean }[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < n; i++) {
        const r = await renderRecipe($state.snapshot(recipe), Math.random);
        if (seen.has(r.body)) continue; // same fonts twice → same MOTD; skip duplicates
        seen.add(r.body);
        if (maxLineBytes(r.body) > LINE_BYTE_BUDGET) continue;
        items.push({ name: `${g} · ${fontsLabel(r.fonts)}`, body: r.body, enabled: true });
      }
      if (!items.length) { toastError('Every variant exceeded the line byte budget; narrow the banner.'); return; }
      const next = await batchMotd({ group: g, recipe: JSON.stringify($state.snapshot(recipe)), items });
      apply(next, `Generated ${items.length} variant${items.length === 1 ? '' : 's'} in "${g}"`);
      const first = next.templates.find((t) => t.group === g);
      if (first) load(first);
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      generating = false;
    }
  }

  async function doDelete() {
    const t = askDelete;
    if (!t) return;
    try {
      const next = await deleteMotd(t.id);
      apply(next, `Deleted "${t.name}"`);
      if (selectedId === t.id) load(next.templates[0] ?? null);
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      askDelete = null;
    }
  }

  async function rotate(id?: string) {
    if (rotating) return;
    rotating = true;
    try {
      data = await rotateMotd(id);
      toastSuccess(id ? 'IRCd now serves this template' : 'IRCd rotated to a random template');
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      rotating = false;
    }
  }

  /** Pin = served to everyone (engine on every connect + ircd file) until unpinned. */
  async function pin(id: string | null) {
    if (rotating) return;
    rotating = true;
    try {
      data = id ? await pinMotd(id) : await unpinMotd();
      toastSuccess(id ? 'Pinned — every connect gets this template until you unpin' : 'Unpinned — back to a random template per connect');
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      rotating = false;
    }
  }
  const pinnedId = $derived(data?.rotation.pinnedId ?? '');
  const pinned = $derived(templates.find((t) => t.id === pinnedId) ?? null);


  function onBuilderRendered(rendered: string) {
    if (rendered !== body) { body = rendered; dirty = true; }
  }
  function switchMode(m: 'raw' | 'builder') {
    if (m === mode) return;
    if (m === 'raw' && !confirm('Switch to the raw editor? The block recipe is kept on this template until you save from raw mode.')) return;
    mode = m;
    dirty = true;
  }

  function onBodyInput() { dirty = true; }

  /** Splices a rendered banner into the body at the caret and re-focuses it. */
  function insertFont(entry: FontEntry, lines: string[]) {
    const el = textarea;
    const at = el ? el.selectionStart : body.length;
    const next = insertBanner(body, at, lines);
    body = next.body;
    dirty = true;
    lastFont = { kind: entry.kind, name: entry.name };
    fontKind = entry.kind;
    toastSuccess(`Inserted ${entry.name} (${lines.length} lines)`);
    queueMicrotask(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  }
  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<PageHeader
  title="MOTD"
  subtitle="Templates served at random on every connect to irc.ircfiber.com; one is rotated into the ircd hourly"
>
  {#snippet actions()}
    <button
      type="button"
      onclick={() => void rotate()}
      disabled={rotating || enabledCount === 0}
      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
      title="Write a random enabled template into the ircd MOTD file and REHASH"
    >
      {rotating ? 'Rotating…' : 'Rotate ircd now'}
    </button>
    <button
      type="button"
      onclick={() => void refresh(true)}
      disabled={loading}
      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
    >
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  {/snippet}
</PageHeader>

{#if loadError}
  <Card><p class="text-sm text-danger">{loadError}</p></Card>
{:else if data}
  {#if data.rotation.error}
    <div class="mb-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-text" role="alert">
      Last ircd rotation failed: {data.rotation.error}. Per-connect MOTDs are unaffected; native clients keep the previous file.
    </div>
  {/if}

  <div class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
    <div class="space-y-4">
      <Card title="Templates" subtitle="{enabledCount} of {templates.length} enabled">
        {#snippet actions()}
          <button type="button" onclick={() => startNew(true)} class="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-white hover:bg-primary/90">
            Build
          </button>
          <button type="button" onclick={() => startNew(false)} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">
            Raw
          </button>
        {/snippet}
        {#if templates.length === 0}
          <EmptyState title="No templates" description="Create one to start serving custom MOTDs." />
        {:else}
          <ul class="divide-y divide-border/50">
            {#each templates as t (t.id)}
              <li>
                <button
                  type="button"
                  onclick={() => select(t)}
                  class="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left text-sm hover:bg-surface-3 {selectedId === t.id ? 'bg-primary/10' : ''}"
                >
                  <span class="min-w-0">
                    <span class="block truncate font-medium text-heading">{t.name}</span>
                    <span class="block truncate text-xs text-muted">
                      {maxColumns(t.body)} cols · {t.body.replace(/\n+$/, '').split('\n').length} lines · {relative(t.updatedAt)}{t.group ? ` · ${t.group}` : ''}
                    </span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1.5">
                    {#if t.recipe}
                      <StatusBadge label="built" tone="primary" size="sm" dot={false} />
                    {/if}
                    {#if pinnedId === t.id}
                      <StatusBadge label="pinned" tone="warn" size="sm" dot={false} />
                    {:else if data.rotation.current?.id === t.id}
                      <StatusBadge label="on ircd" tone="info" size="sm" dot={false} />
                    {/if}
                    <StatusBadge label={t.enabled ? 'enabled' : 'off'} tone={t.enabled ? 'success' : 'muted'} size="sm" />
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>

      <Card title="Serving">
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="text-muted">On connect</dt>
            <dd class="truncate font-mono">{pinned ? `pinned: ${pinned.name}` : `random of ${enabledCount}`}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-muted">IRCd file</dt>
            <dd class="truncate font-mono">{data.rotation.current?.name ?? '— (unchanged)'}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-muted">Rotated</dt>
            <dd class="font-mono">{data.rotation.current ? relative(data.rotation.current.at) : '—'}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-muted">Interval</dt>
            <dd class="font-mono">{pinned ? 'paused while pinned' : `${Math.round(data.rotation.intervalMs / 60000)} min + every save`}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-muted">File</dt>
            <dd class="truncate font-mono text-xs">{data.rotation.file}</dd>
          </div>
        </dl>
        {#if pinned}
          <button type="button" onclick={() => void pin(null)} disabled={rotating} class="mt-3 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40">
            Unpin
          </button>
        {/if}
        <p class="mt-3 text-xs text-muted">
          Users on IRC Fiber get the pinned template, or a random enabled one, on every connect. Native clients see the ircd file, which follows the pin or rotates hourly and on every save.
        </p>
      </Card>
    </div>

    <div class="space-y-4">
      <Card title={selectedId === null ? 'New template' : 'Edit template'}>
        {#snippet actions()}
          <span class="mr-2 inline-flex overflow-hidden rounded-md border border-border text-xs">
            <button type="button" onclick={() => switchMode('builder')} class="px-2.5 py-1 {mode === 'builder' ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-muted'}">Builder</button>
            <button type="button" onclick={() => switchMode('raw')} class="px-2.5 py-1 {mode === 'raw' ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-muted'}">Raw</button>
          </span>
          {#if selected}
            <button
              type="button"
              onclick={() => void pin(pinnedId === selected.id ? null : selected.id)}
              disabled={rotating || (!selected.enabled && pinnedId !== selected.id) || dirty}
              class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
              title={dirty ? 'Save first' : pinnedId === selected.id ? 'Back to a random template per connect' : 'Serve this template to everyone (engine + ircd) until unpinned'}
            >
              {pinnedId === selected.id ? 'Unpin' : 'Pin'}
            </button>
            <button
              type="button"
              onclick={() => { askDelete = selected; }}
              class="rounded-md border border-danger/40 bg-surface-2 px-2.5 py-1 text-xs text-danger hover:bg-danger/10"
            >
              Delete
            </button>
          {/if}
          <button
            type="button"
            onclick={() => void save()}
            disabled={saving || !dirty}
            class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
          >
            {saving ? 'Saving…' : selectedId === null ? 'Create' : 'Save'}
          </button>
        {/snippet}

        <div class="mb-3 flex flex-wrap items-center gap-3">
          <label class="flex min-w-64 flex-1 items-center gap-2 text-sm">
            <span class="text-muted">Name</span>
            <input
              type="text"
              bind:value={name}
              oninput={() => { dirty = true; }}
              maxlength="80"
              class="flex-1 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
            />
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={enabled} onchange={() => { dirty = true; }} />
            <span>Enabled</span>
          </label>
          <span class="text-xs {tooLong ? 'text-danger' : tooWide ? 'text-warn' : 'text-muted'}">
            {lineCount} lines · {cols} cols · {bytes} B/line max{tooLong ? ` — over the ${LINE_BYTE_BUDGET} B line budget` : tooWide ? ' — wider than 80, will wrap in most clients' : ''}
          </span>
        </div>

        {#if mode === 'builder'}
          <div class="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <MotdBuilder bind:recipe onRendered={onBuilderRendered} />
            <div>
              <div class="mb-1 text-xs uppercase tracking-wider text-muted">Preview</div>
              <pre class="motd-preview overflow-x-auto rounded-md border border-border bg-black px-3 py-2 font-mono text-[12px] leading-[1.25] text-[#d2d2d2]">{@html previewHtml}</pre>
            </div>
          </div>
        {:else}
          <div class="grid gap-3 2xl:grid-cols-2">
            <div class="relative">
              <textarea
                bind:this={textarea}
                bind:value={body}
                oninput={onBodyInput}
                spellcheck="false"
                wrap="off"
                rows="26"
                class="motd-edit w-full resize-y rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-[12px] leading-[1.25]"
              ></textarea>
            </div>
            <div>
              <div class="mb-1 text-xs uppercase tracking-wider text-muted">Preview</div>
              <pre class="motd-preview overflow-x-auto rounded-md border border-border bg-black px-3 py-2 font-mono text-[12px] leading-[1.25] text-[#d2d2d2]">{@html previewHtml}</pre>
            </div>
          </div>
        {/if}
      </Card>

      {#if mode === 'builder'}
        <Card title="Variants" subtitle="Render this recipe several times with fresh random fonts and keep them all as one group">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <label class="flex items-center gap-1.5 text-xs text-muted">
              count <input type="number" min="1" max="50" bind:value={variantCount} class="w-16 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-sm" />
            </label>
            <label class="flex items-center gap-1.5 text-xs text-muted">
              group <input type="text" bind:value={variantGroup} maxlength="80" class="w-56 rounded border border-border bg-surface-2 px-2 py-0.5 text-sm" />
            </label>
            <button
              type="button"
              onclick={() => void generateVariants()}
              disabled={generating}
              class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
            >
              {generating ? 'Generating…' : groups.has(variantGroup.trim()) ? `Regenerate (${groups.get(variantGroup.trim())} in group)` : 'Generate variants'}
            </button>
            <span class="text-xs text-muted">Replaces every template in the group; duplicates (same fonts) are skipped.</span>
          </div>
        </Card>
      {:else}
        <Card title="Banner font" subtitle="Insert FIGlet or TheDraw art at the cursor">
          {#snippet actions()}
            <button
              type="button"
              onclick={() => { fontOpen = !fontOpen; }}
              class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
            >
              {fontOpen ? 'Close' : 'Browse fonts'}
            </button>
          {/snippet}
          {#if fontOpen}
            <MotdFontPicker
              action="insert"
              kind={fontKind}
              sample={fontSample}
              selected={lastFont}
              onPick={insertFont}
            />
          {:else}
            <p class="text-xs text-muted">
              {lastFont ? `Last inserted: ${lastFont.name}.` : 'Browse every FIGlet and TheDraw font as a live sample of your own word.'}
            </p>
          {/if}
        </Card>
      {/if}
    </div>
  </div>
{/if}

<ConfirmDialog
  open={askDelete !== null}
  title="Delete this template?"
  message={askDelete ? `"${askDelete.name}" is removed from the rotation immediately. This cannot be undone.` : ''}
  confirmLabel="Delete"
  cancelLabel="Cancel"
  tone="danger"
  onConfirm={doDelete}
  onCancel={() => { askDelete = null; }}
/>

<style>
  /* 80-column guide: 1ch is the mono advance, so 80ch after the padding. */
  .motd-edit,
  .motd-preview {
    background-image: linear-gradient(
      to right,
      transparent calc(0.75rem + 80ch),
      rgba(248, 81, 73, 0.35) calc(0.75rem + 80ch),
      rgba(248, 81, 73, 0.35) calc(0.75rem + 80ch + 1px),
      transparent calc(0.75rem + 80ch + 1px)
    );
    background-attachment: local;
    tab-size: 4;
    white-space: pre;
  }
  /* parseIrcFormatting plants <wbr> at every colour boundary for chat
     wrapping; a <wbr> breaks even inside white-space: pre, so coloured
     art would wrap here. The preview must never wrap — it scrolls.
     :global — the <wbr> lives inside {@html}, which the compiler cannot
     see; without it this rule is pruned as unused. */
  .motd-preview :global(wbr) { display: none; }
</style>
