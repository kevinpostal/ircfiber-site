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
   * Editor: monospace textarea with an 80-column guide, live preview, and a
   * FIGlet generator that inserts banner art at the cursor.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { relative } from '../lib/format';
  import { FIGLET_FONTS, renderFiglet } from '../lib/figlet';
  import {
    fetchMotd, createMotd, updateMotd, deleteMotd, rotateMotd, maxColumns,
    type MotdState, type MotdTemplate, type MotdTemplateInput,
  } from '../stores/motd';

  let state = $state<MotdState | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);

  // Editor: `selectedId` is null for a new, unsaved template.
  let selectedId = $state<string | null>(null);
  let name = $state('');
  let body = $state('');
  let enabled = $state(true);
  let dirty = $state(false);
  let saving = $state(false);
  let rotating = $state(false);
  let askDelete = $state<MotdTemplate | null>(null);
  let textarea = $state<HTMLTextAreaElement | null>(null);

  // FIGlet generator
  let figText = $state('IRC Fiber');
  let figFont = $state('ANSI Shadow');
  let figOut = $state('');
  let figBusy = $state(false);
  const fontNames = Object.keys(FIGLET_FONTS);

  const templates = $derived(state?.templates ?? []);
  const selected = $derived(templates.find((t) => t.id === selectedId) ?? null);
  const enabledCount = $derived(templates.filter((t) => t.enabled).length);
  const cols = $derived(maxColumns(body));
  const lineCount = $derived(body.replace(/\n+$/, '').split('\n').length);
  const tooWide = $derived(cols > 80);

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  function load(t: MotdTemplate | null) {
    selectedId = t?.id ?? null;
    name = t?.name ?? '';
    body = t?.body ?? '';
    enabled = t?.enabled ?? true;
    dirty = false;
  }

  function select(t: MotdTemplate) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    load(t);
  }

  function startNew() {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    load(null);
    name = 'New template';
    dirty = true;
  }

  async function refresh(spinner = state === null) {
    if (spinner) loading = true;
    loadError = null;
    try {
      state = await fetchMotd();
      if (selectedId === null && !dirty && state.templates.length) load(state.templates[0]);
    } catch (e) {
      loadError = errMsg(e);
    } finally {
      loading = false;
    }
  }
  onMount(() => { void refresh(); });

  /** Applies a write result; the server returns the whole list each time. */
  function apply(next: MotdState, okMsg: string) {
    state = next;
    if (next.rotation.error) toastError(`${okMsg} — ircd rotation failed: ${next.rotation.error}`);
    else toastSuccess(okMsg);
  }

  async function save() {
    if (saving) return;
    const input: MotdTemplateInput = { name: name.trim(), body, enabled };
    if (!input.name) { toastError('Name is required'); return; }
    saving = true;
    try {
      if (selectedId === null) {
        const next = await createMotd(input);
        const created = next.templates.find((t) => !templates.some((p) => p.id === t.id));
        apply(next, 'Template created');
        if (created) load(created);
        else dirty = false;
      } else {
        apply(await updateMotd(selectedId, input), 'Template saved');
        dirty = false;
      }
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      saving = false;
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
      state = await rotateMotd(id);
      toastSuccess(id ? 'IRCd now serves this template' : 'IRCd rotated to a random template');
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      rotating = false;
    }
  }

  async function generate() {
    if (figBusy || !figText.trim()) return;
    figBusy = true;
    try {
      figOut = await renderFiglet(figText, figFont);
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      figBusy = false;
    }
  }

  /** Inserts the generated art at the textarea cursor (or at the top). */
  function insertArt() {
    if (!figOut) return;
    const el = textarea;
    const at = el ? el.selectionStart : 0;
    const before = body.slice(0, at);
    const after = body.slice(at);
    const chunk = figOut + '\n';
    body = before + (before && !before.endsWith('\n') ? '\n' : '') + chunk + after;
    dirty = true;
    queueMicrotask(() => {
      if (!el) return;
      const pos = at + chunk.length + (before && !before.endsWith('\n') ? 1 : 0);
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function onBodyInput() { dirty = true; }
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
{:else if state}
  {#if state.rotation.error}
    <div class="mb-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-text" role="alert">
      Last ircd rotation failed: {state.rotation.error}. Per-connect MOTDs are unaffected; native clients keep the previous file.
    </div>
  {/if}

  <div class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
    <div class="space-y-4">
      <Card title="Templates" subtitle="{enabledCount} of {templates.length} enabled">
        {#snippet actions()}
          <button
            type="button"
            onclick={startNew}
            class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
          >
            New
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
                    <span class="block truncate text-xs text-muted">{maxColumns(t.body)} cols · {t.body.replace(/\n+$/, '').split('\n').length} lines · {relative(t.updatedAt)}</span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1.5">
                    {#if state.rotation.current?.id === t.id}
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

      <Card title="IRCd rotation">
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="text-muted">Serving</dt>
            <dd class="truncate font-mono">{state.rotation.current?.name ?? '— (file unchanged)'}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-muted">Rotated</dt>
            <dd class="font-mono">{state.rotation.current ? relative(state.rotation.current.at) : '—'}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-muted">Interval</dt>
            <dd class="font-mono">{Math.round(state.rotation.intervalMs / 60000)} min + every save</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="text-muted">File</dt>
            <dd class="truncate font-mono text-xs">{state.rotation.file}</dd>
          </div>
        </dl>
        <p class="mt-3 text-xs text-muted">
          InspIRCd caches the MOTD per REHASH, so native clients see the rotated file; users on IRC Fiber get a fresh random pick on each connect regardless.
        </p>
      </Card>
    </div>

    <div class="space-y-4">
      <Card title={selectedId === null ? 'New template' : 'Edit template'}>
        {#snippet actions()}
          {#if selected}
            <button
              type="button"
              onclick={() => void rotate(selected.id)}
              disabled={rotating || !selected.enabled || dirty}
              class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
              title={dirty ? 'Save first' : 'Write this template into the ircd MOTD file and REHASH'}
            >
              Serve on ircd
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
          <span class="text-xs {tooWide ? 'text-warn' : 'text-muted'}">
            {lineCount} lines · {cols} cols{tooWide ? ' — wider than 80, will wrap in most clients' : ''}
          </span>
        </div>

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
            <pre class="motd-preview overflow-x-auto rounded-md border border-border bg-black px-3 py-2 font-mono text-[12px] leading-[1.25] text-[#e6edf3]">{body || ' '}</pre>
          </div>
        </div>
      </Card>

      <Card title="FIGlet banner" subtitle="Generate ASCII art and insert it at the cursor">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            bind:value={figText}
            placeholder="IRC Fiber"
            class="w-56 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
          />
          <select bind:value={figFont} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm">
            {#each fontNames as f (f)}
              <option value={f}>{f}</option>
            {/each}
          </select>
          <button
            type="button"
            onclick={() => void generate()}
            disabled={figBusy || !figText.trim()}
            class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
          >
            {figBusy ? 'Rendering…' : 'Generate'}
          </button>
          <button
            type="button"
            onclick={insertArt}
            disabled={!figOut}
            class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-40"
          >
            Insert at cursor
          </button>
          {#if figOut}
            <span class="text-xs text-muted">{maxColumns(figOut)} cols</span>
          {/if}
        </div>
        {#if figOut}
          <pre class="motd-preview overflow-x-auto rounded-md border border-border bg-black px-3 py-2 font-mono text-[12px] leading-[1.25] text-[#e6edf3]">{figOut}</pre>
        {/if}
      </Card>
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
</style>
