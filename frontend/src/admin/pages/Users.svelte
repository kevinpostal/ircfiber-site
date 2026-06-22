<script lang="ts">
  /**
   * Users page — list + search + new user button. Phase 3 will replace
   * the diet-template; this stub fetches the JSON API to prove the
   * wiring works end-to-end.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import { api, ApiError } from '../lib/api-client';

  interface UserRow {
    id: string;
    username: string;
    email: string;
    roles: string[];
  }

  let users = $state<UserRow[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let q = $state('');

  async function load() {
    loading = true; error = null;
    try {
      const res = await api.get<{ users: UserRow[]; count: number }>('/api/admin/users', { q: q || undefined });
      users = res.users ?? [];
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  onMount(load);
</script>

<PageHeader title="Users" subtitle="All registered accounts">
  {#snippet actions()}
    <a href="/admin/users/new" class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90">+ New user</a>
  {/snippet}
</PageHeader>

<Card>
  <div class="mb-4 flex items-center gap-2">
    <input
      type="search"
      bind:value={q}
      onkeydown={(e) => e.key === 'Enter' && load()}
      placeholder="Search by username…"
      class="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder-muted focus:border-primary focus:outline-none"
    />
    <button onclick={load} class="rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text hover:border-primary/40">Search</button>
  </div>

  {#if error}
    <div class="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
  {/if}

  {#if loading && users.length === 0}
    <div class="flex h-32 items-center justify-center">
      <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
    </div>
  {:else if users.length === 0}
    <EmptyState icon="👥" title="No users" description={q ? `No users match "${q}".` : 'No users registered yet.'} />
  {:else}
    <table class="w-full text-sm">
      <thead class="text-xs uppercase tracking-wider text-muted">
        <tr class="border-b border-border">
          <th class="py-2 text-left font-semibold">Username</th>
          <th class="py-2 text-left font-semibold">Email</th>
          <th class="py-2 text-left font-semibold">Roles</th>
          <th class="py-2 text-right font-semibold">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each users as u (u.id)}
          <tr class="border-b border-border/40 hover:bg-surface/40">
            <td class="py-2 font-medium text-text">{u.username}</td>
            <td class="py-2 text-muted">{u.email}</td>
            <td class="py-2">
              <div class="flex flex-wrap gap-1">
                {#each u.roles as role}
                  <StatusBadge label={role} tone={role === 'admin' ? 'primary' : 'muted'} size="sm" />
                {/each}
              </div>
            </td>
            <td class="py-2 text-right">
              <a href="#/users/{u.id}" class="text-xs text-primary hover:underline">View →</a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</Card>