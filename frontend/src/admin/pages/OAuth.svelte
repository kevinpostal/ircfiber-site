<script lang="ts">
  /**
   * OAuth page — social-login provider status + credential configuration.
   *
   * Status comes from GET /api/admin/oauth/status, which reads the same
   * `loadOAuthSettings` the public routes use — what this page shows is
   * exactly what the buttons reflect. Credentials come from deployed env
   * (always wins) or the admin override (Redis, fills only halves env
   * leaves empty). Secrets are write-only: the API reports `hasSecret`,
   * never the value. Saving takes effect immediately, no restart.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { toastSuccess, toastError } from '../stores/ui';
  import { api } from '../lib/api-client';

  interface OAuthRow {
    name: string;
    label: string;
    configured: boolean;
    source: 'env' | 'override' | 'mixed' | 'off';
    clientId: string;
    hasSecret: boolean;
    envId: string;
    envHasSecret: boolean;
    redirectUri: string;
  }

  const setupGuide: Record<string, { where: string; url: string; note: string }> = {
    github: {
      where: 'GitHub → Settings → Developer settings → OAuth Apps → New OAuth App',
      url: 'https://github.com/settings/developers',
      note: 'Homepage URL https://ircfiber.com. Client secrets cannot be shown again after creation.',
    },
    google: {
      where: 'Cloud console → APIs & Services → Credentials → Create Credentials → OAuth client ID (Web)',
      url: 'https://console.cloud.google.com/apis/credentials',
      note: 'Add the callback under Authorized redirect URIs.',
    },
    codeberg: {
      where: 'Codeberg → Settings → Applications → Create application (confidential client)',
      url: 'https://codeberg.org/user/settings/applications',
      note: 'Confirm the demanded scope on the registration form; basic profile + email needs none.',
    },
    gitlab: {
      where: 'GitLab → User Settings → Applications → New application',
      url: 'https://gitlab.com/-/user_settings/applications',
      note: 'Tick the read_user, openid and email scopes.',
    },
  };

  let rows = $state<OAuthRow[]>([]);
  let loading = $state(true);
  let error = $state('');
  let clientEdits = $state<Record<string, string>>({});
  let secretEdits = $state<Record<string, string>>({});
  let saving = $state<Record<string, boolean>>({});
  let clearing = $state<Record<string, boolean>>({});
  let confirmClear = $state<string | null>(null);

  function sourceBadge(r: OAuthRow): { label: string; tone: 'success' | 'muted' | 'info' | 'warn' } {
    if (!r.configured) return { label: 'Off', tone: 'muted' };
    if (r.source === 'env') return { label: 'Live · env', tone: 'success' };
    if (r.source === 'override') return { label: 'Live · admin', tone: 'info' };
    return { label: 'Live · mixed', tone: 'warn' };
  }

  function hasOverride(r: OAuthRow): boolean {
    return (r.clientId.length > 0 && r.clientId !== r.envId) || (r.hasSecret && !r.envHasSecret);
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const data = await api.get<{ providers: OAuthRow[] }>('/admin/oauth/status');
      rows = data.providers ?? [];
      for (const r of rows) {
        if (!(r.name in clientEdits)) clientEdits[r.name] = r.clientId;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load provider status.';
    } finally {
      loading = false;
    }
  }

  async function save(name: string): Promise<void> {
    const id = (clientEdits[name] ?? '').trim();
    const secret = (secretEdits[name] ?? '').trim();
    if (!id) {
      toastError('Client ID is required.');
      return;
    }
    saving[name] = true;
    try {
      await api.post(`/admin/oauth/${name}`, { clientId: id, ...(secret ? { clientSecret: secret } : {}) });
      secretEdits[name] = '';
      toastSuccess(`${name}: credentials saved — provider is live if both halves are set.`);
      await load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : `Could not save ${name}.`);
    } finally {
      saving[name] = false;
    }
  }

  async function clear(name: string): Promise<void> {
    clearing[name] = true;
    try {
      await api.delete(`/admin/oauth/${name}`);
      confirmClear = null;
      toastSuccess(`${name}: admin override cleared.`);
      await load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : `Could not clear ${name}.`);
    } finally {
      clearing[name] = false;
    }
  }

  onMount(() => void load());
</script>

<PageHeader
  title="Social login"
  subtitle="One-click signup via GitHub, Google, Codeberg and GitLab. Saving takes effect immediately — no restart."
/>

{#if loading}
  <div class="flex items-center justify-center py-16">
    <div class="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
  </div>
{:else if error}
  <EmptyState title="Could not load providers" detail={error} />
{:else}
  <Card title="Providers" subtitle="Live state is read through the same settings the login routes use.">
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead>
          <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
            <th class="pb-2 pr-4">Provider</th>
            <th class="pb-2 pr-4">Status</th>
            <th class="pb-2 pr-4">Client ID</th>
            <th class="pb-2 pr-4">Secret</th>
            <th class="pb-2">Callback to register</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r}
            {@const badge = sourceBadge(r)}
            <tr class="border-b border-border last:border-0" data-provider={r.name}>
              <td class="py-2.5 pr-4 font-semibold text-heading">{r.label}</td>
              <td class="py-2.5 pr-4"><StatusBadge label={badge.label} tone={badge.tone} size="sm" /></td>
              <td class="py-2.5 pr-4 font-mono text-xs text-muted">{r.clientId || '—'}</td>
              <td class="py-2.5 pr-4 text-xs text-muted">{r.hasSecret ? 'Set' : 'Not set'}</td>
              <td class="py-2.5 font-mono text-xs text-muted">{r.redirectUri}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="mt-3 text-xs text-muted">
      Deployed environment always wins: an admin override only fills halves the environment leaves empty.
      Secrets are write-only — this page never displays one.
    </p>
  </Card>

  <div class="mt-6 grid gap-6 lg:grid-cols-2">
    {#each rows as r}
      <div data-editor={r.name}>
        <Card title={r.label} subtitle={setupGuide[r.name]?.where ?? ''}>
        <div class="flex flex-col gap-3">
          <label class="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-muted">
            Client ID
            <input
              class="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-sm normal-case tracking-normal text-heading"
              bind:value={clientEdits[r.name]}
              placeholder="OAC-…"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label class="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wider text-muted">
            Client secret
            <input
              type="password"
              class="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm normal-case tracking-normal text-heading"
              bind:value={secretEdits[r.name]}
              placeholder={r.hasSecret ? 'Set — leave blank to keep' : 'Required to enable'}
              autocomplete="new-password"
            />
          </label>
          {#if r.envId || r.envHasSecret}
            <p class="text-xs text-muted">
              Environment provides {r.envId ? 'the ID' : ''}{r.envId && r.envHasSecret ? ' and ' : ''}{r.envHasSecret ? 'the secret' : ''} — it wins over anything saved here.
            </p>
          {/if}
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="rounded-md border border-primary/40 bg-surface px-2.5 py-1 text-xs hover:border-primary disabled:opacity-40"
              disabled={!!saving[r.name]}
              onclick={() => void save(r.name)}
            >
              {saving[r.name] ? 'Saving…' : 'Save'}
            </button>
            {#if hasOverride(r)}
              {#if confirmClear === r.name}
                <button
                  type="button"
                  class="rounded-md border border-danger/40 px-2.5 py-1 text-xs text-danger hover:border-danger disabled:opacity-40"
                  disabled={!!clearing[r.name]}
                  onclick={() => void clear(r.name)}
                >
                  {clearing[r.name] ? 'Clearing…' : 'Confirm clear override'}
                </button>
                <button
                  type="button"
                  class="rounded-md border border-border px-2.5 py-1 text-xs hover:border-primary/40"
                  onclick={() => (confirmClear = null)}
                >
                  Cancel
                </button>
              {:else}
                <button
                  type="button"
                  class="rounded-md border border-border px-2.5 py-1 text-xs hover:border-primary/40"
                  onclick={() => (confirmClear = r.name)}
                >
                  Clear override
                </button>
              {/if}
            {/if}
          </div>
        </div>
        </Card>
      </div>
    {/each}
  </div>

  <Card title="Registering an app" subtitle="One app per provider you enable." class="mt-6">
    <ul class="flex flex-col gap-3 text-sm">
      {#each rows as r}
        <li data-guide={r.name}>
          <span class="font-semibold text-heading">{r.label}:</span>
          <span class="text-muted"> {setupGuide[r.name]?.note ?? ''}</span>
          <a class="ml-1 text-primary hover:underline" href={setupGuide[r.name]?.url} target="_blank" rel="noreferrer">
            Open registration →
          </a>
        </li>
      {/each}
    </ul>
  </Card>
{/if}
