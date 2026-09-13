<script lang="ts">
  /**
   * Embedding page — the iframe-embedding allowlist.
   *
   * Listed origins may embed the whole site in an iframe; an empty list
   * blocks embedding entirely. State comes from GET
   * /api/admin/config/embed-origins and saves through POST to the same
   * path, which persists to Redis `irc:config:embedOrigins` and takes
   * effect immediately — no restart.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StringListEditor from '../components/StringListEditor.svelte';
  import { ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import {
    embedOriginsConfig,
    embedOriginsLoading,
    embedOriginsError,
    embedOriginsSaving,
    fetchEmbedOrigins,
    saveEmbedOrigins,
    validateEmbedOrigin,
    EMBED_ORIGINS_MAX,
  } from '../stores/embedOrigins';

  let origins = $state<string[]>([]);
  let saveErrors = $state<string[]>([]);
  let dirty = $state(false);

  const siteOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const snippet = $derived(
    `<iframe src="${siteOrigin}" title="IRC Fiber" width="100%" height="640" loading="lazy" allow="clipboard-write" style="border:0"></iframe>`,
  );

  function seed() {
    origins = [...($embedOriginsConfig?.origins ?? [])];
    saveErrors = [];
    dirty = false;
  }

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function reload(): Promise<void> {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    await fetchEmbedOrigins();
    seed();
  }

  function touch() { dirty = true; }

  async function save(): Promise<void> {
    if ($embedOriginsSaving) return;
    // Client-side mirror of the server's rules (instant feedback; the
    // server stays authoritative and its errors[] still render below).
    const problems: string[] = [];
    if (origins.length > EMBED_ORIGINS_MAX) {
      problems.push(`At most ${EMBED_ORIGINS_MAX} origins — remove ${origins.length - EMBED_ORIGINS_MAX}.`);
    }
    for (const o of origins) {
      const problem = validateEmbedOrigin(o);
      if (problem) problems.push(`${o}: ${problem}`);
    }
    if (problems.length) {
      saveErrors = problems;
      return;
    }
    saveErrors = [];
    try {
      await saveEmbedOrigins(origins);
      seed();
      toastSuccess('Embed allowlist saved — the new frame policy is live.');
    } catch (e) {
      // A refused save keeps the form dirty and shows every reason, so the
      // admin fixes all of them in one pass.
      saveErrors = e instanceof ApiError && e.errors.length ? e.errors : [errMsg(e)];
      toastError(errMsg(e));
    }
  }

  async function copySnippet(): Promise<void> {
    try {
      await navigator.clipboard.writeText(snippet);
      toastSuccess('Embed snippet copied — paste it into the partner page.');
    } catch {
      toastError('Could not copy — select the snippet and copy it manually.');
    }
  }

  onMount(() => { void fetchEmbedOrigins().then(seed); });
</script>

<PageHeader
  title="Embedding"
  subtitle="Which partner sites may embed IRC Fiber in an iframe. Saving takes effect immediately — no restart."
>
  {#snippet actions()}
    <button
      type="button" onclick={() => void save()} disabled={$embedOriginsSaving || !dirty}
      class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
    >
      {$embedOriginsSaving ? 'Saving…' : 'Save'}
    </button>
    <button
      type="button" onclick={() => void reload()} disabled={$embedOriginsSaving || $embedOriginsLoading}
      class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
    >
      Reload
    </button>
  {/snippet}
</PageHeader>

{#if $embedOriginsLoading && !$embedOriginsConfig}
  <div class="flex items-center justify-center py-16">
    <div class="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
  </div>
{:else if $embedOriginsError && !$embedOriginsConfig}
  <EmptyState title="Could not load the embed allowlist" description={$embedOriginsError ?? 'Unknown error'} />
{:else}
  <Card title="Allowed origins" subtitle="Partner origins that may frame the whole site.">
    <StringListEditor
      label="Embed origins"
      bind:entries={origins}
      placeholder="https://partner.example"
      helpText="One origin per entry as scheme://host[:port] — https, or http only for localhost. No paths, no wildcards. Up to 16."
      validate={validateEmbedOrigin}
      onchange={touch}
      inputId="embed-origin"
    />

    {#if saveErrors.length}
      <ul class="mt-4 space-y-1 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
        {#each saveErrors as e (e)}<li>{e}</li>{/each}
      </ul>
    {/if}

    <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
      <button type="button" onclick={() => void save()} disabled={$embedOriginsSaving || !dirty}
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
        {$embedOriginsSaving ? 'Saving…' : 'Save allowlist'}
      </button>
      <button type="button" onclick={() => void reload()} disabled={$embedOriginsSaving || $embedOriginsLoading}
        class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-border disabled:opacity-50">
        Reload
      </button>
      <span class="text-xs text-muted">
        {#if dirty}
          Unsaved changes.
        {:else if origins.length === 0}
          Empty — embedding is fully blocked.
        {:else}
          {origins.length} of {EMBED_ORIGINS_MAX} origin{origins.length === 1 ? '' : 's'} allowed.
        {/if}
      </span>
    </div>
  </Card>

  <Card title="How embedding works" subtitle="What the allowlist actually controls." class="mt-6">
    <ul class="flex flex-col gap-2 text-sm">
      <li><span class="font-medium text-heading">Allowed origins</span> may embed the whole site in an iframe.</li>
      <li><span class="font-medium text-heading">Empty list</span> means embedding is fully blocked (X-Frame-Options: DENY).</li>
      <li><span class="font-medium text-heading">/admin is never embeddable</span>, regardless of this list.</li>
      <li>While the list is non-empty the session cookie is issued <code class="font-mono text-xs">SameSite=None</code>, which is what lets a logged-in embed work at all.</li>
      <li>Safari and Firefox still block third-party cookies, so partners there may need the Storage Access API before a framed login sticks.</li>
    </ul>
  </Card>

  <Card title="Partner snippet" subtitle="Copy-paste iframe tag for a partner page." class="mt-6">
    <pre class="overflow-x-auto rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-text">{snippet}</pre>
    <div class="mt-3">
      <button
        type="button" onclick={() => void copySnippet()}
        class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-border"
      >
        Copy snippet
      </button>
    </div>
  </Card>
{/if}
