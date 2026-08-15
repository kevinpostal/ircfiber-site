<script lang="ts">
  /**
   * Users page — Django admin parity: bulk select, bulk delete, filter/search, sort, pagination.
   * No external table lib — custom Svelte 5 runes implementation using existing Card/PageHeader/ConfirmDialog.
   * Evaluated @vincjo/datatables & tanstack/svelte-table: both Svelte 4-era, Svelte 5 runes compat incomplete,
   * extra weight for simple Django feature set. Custom gives full Django visual/behavior control.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { api, ApiError } from '../lib/api-client';

  interface UserRow {
    id: string;
    username: string;
    email: string;
    roles: string[];
    createdAt?: number;
    signupIp?: string;
  }

  type SortKey = 'username' | 'email' | 'roles' | 'createdAt';
  type SortDir = 'asc' | 'desc';

  let users = $state<UserRow[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let q = $state('');
  let roleFilter = $state<'all' | 'admin' | 'user'>('all');
  let sortKey = $state<SortKey>('username');
  let sortDir = $state<SortDir>('asc');

  let page = $state(1);
  const pageSize = 25;

  let selected = $state<Set<string>>(new Set());
  let bulkAction = $state('');
  let showBulkConfirm = $state(false);
  let bulkDeleting = $state(false);
  let bulkError = $state<string | null>(null);
  let bulkSuccess = $state<string | null>(null);

  // Derived filtered + sorted
  const filtered = $derived.by(() => {
    let out = [...users];
    const needle = q.trim().toLowerCase();
    if (needle) {
      out = out.filter((u) => u.username.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle));
    }
    if (roleFilter !== 'all') {
      out = out.filter((u) => (roleFilter === 'admin' ? u.roles.includes('admin') : !u.roles.includes('admin')));
    }
    out.sort((a, b) => {
      let va: string | number = '';
      let vb: string | number = '';
      if (sortKey === 'username') { va = a.username.toLowerCase(); vb = b.username.toLowerCase(); }
      else if (sortKey === 'email') { va = a.email.toLowerCase(); vb = b.email.toLowerCase(); }
      else if (sortKey === 'roles') { va = a.roles.join(','); vb = b.roles.join(','); }
      else if (sortKey === 'createdAt') { va = a.createdAt ?? 0; vb = b.createdAt ?? 0; }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  });

  const totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  const paged = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));
  const allVisibleSelected = $derived(paged.length > 0 && paged.every((u) => selected.has(u.id)));
  const anySelected = $derived(selected.size > 0);

  // Reset page when filters change
  $effect(() => { void q; void roleFilter; void sortKey; void sortDir; page = 1; });
  // Clamp page when filtered shrinks
  $effect(() => { if (page > totalPages) page = totalPages; });

  async function load() {
    loading = true; error = null; bulkError = null;
    try {
      const res = await api.get<{ users: UserRow[]; count: number }>('/api/admin/users', { q: q.trim() || undefined });
      users = res.users ?? [];
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = key; sortDir = 'asc'; }
  }

  function toggleOne(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id); else next.delete(id);
    selected = next;
  }
  function toggleAllVisible(checked: boolean) {
    const next = new Set(selected);
    for (const u of paged) {
      if (checked) next.add(u.id); else next.delete(u.id);
    }
    selected = next;
  }
  function clearSelection() { selected = new Set(); }

  function handleBulkGo() {
    bulkError = null; bulkSuccess = null;
    if (!anySelected) { bulkError = 'No users selected.'; return; }
    if (bulkAction !== 'delete') { bulkError = 'Select an action.'; return; }
    showBulkConfirm = true;
  }

  async function confirmBulkDelete() {
    if (bulkDeleting) return;
    bulkDeleting = true; bulkError = null;
    try {
      const ids = [...selected];
      const res = await api.post<{ deleted: number; skipped: string[]; errors: string[] }>('/api/admin/users/bulk-delete', { ids });
      const deleted = res.deleted ?? 0;
      bulkSuccess = `Deleted ${deleted} user${deleted === 1 ? '' : 's'}${res.errors?.length ? ` — ${res.errors.join('; ')}` : ''}${res.skipped?.length ? ` — skipped: ${res.skipped.join(', ')}` : ''}`;
      selected = new Set();
      showBulkConfirm = false;
      bulkAction = '';
      await load();
      setTimeout(() => (bulkSuccess = null), 4000);
    } catch (e) {
      bulkError = e instanceof ApiError ? e.message : (e as Error).message;
      showBulkConfirm = false;
    } finally { bulkDeleting = false; }
  }

  onMount(load);
</script>

<PageHeader title="Users" subtitle="All registered accounts — Django admin style">
  {#snippet actions()}
    <a href="/admin/users/new" class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90">+ Add user</a>
  {/snippet}
</PageHeader>

<Card>
  <!-- Toolbar: search + filters (Django changelist style) -->
  <div class="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="flex flex-1 items-center gap-2">
      <input
        type="search"
        bind:value={q}
        onkeydown={(e) => e.key === 'Enter' && load()}
        placeholder="Search by username or email…"
        class="w-full max-w-[360px] flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder-muted focus:border-primary focus:outline-none"
        aria-label="Search users"
      />
      <button onclick={load} class="rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text hover:border-primary/40">Search</button>
      {#if q}
        <button onclick={() => { q = ''; load(); }} class="text-xs text-muted hover:text-text">Clear</button>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <label class="text-xs font-medium text-muted" for="role-filter">Filter:</label>
      <select id="role-filter" bind:value={roleFilter} class="rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-text focus:border-primary focus:outline-none">
        <option value="all">All roles</option>
        <option value="admin">Admin</option>
        <option value="user">User</option>
      </select>
      <span class="hidden text-xs text-muted sm:inline">{filtered.length} of {users.length} users</span>
    </div>
  </div>

  <!-- Bulk action bar — Django changelist action row -->
  <div class="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
    <label for="bulk-action" class="text-xs font-semibold uppercase tracking-wider text-muted">Action:</label>
    <select
      id="bulk-action"
      bind:value={bulkAction}
      class="min-w-[180px] rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
    >
      <option value="">---------</option>
      <option value="delete">Delete selected users</option>
    </select>
    <button
      onclick={handleBulkGo}
      disabled={!anySelected || !bulkAction}
      class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      Go
    </button>
    <span class="ml-2 text-xs text-muted">
      {#if anySelected}
        {selected.size} of {filtered.length} selected
        <button onclick={clearSelection} class="ml-1 text-primary hover:underline">Clear</button>
      {:else}
        0 selected
      {/if}
    </span>
    {#if bulkError}
      <span class="ml-auto text-xs text-danger">{bulkError}</span>
    {/if}
    {#if bulkSuccess}
      <span class="ml-auto text-xs text-success">{bulkSuccess}</span>
    {/if}
  </div>

  {#if error}
    <div class="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
  {/if}

  {#if loading && users.length === 0}
    <div class="flex h-32 items-center justify-center">
      <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
    </div>
  {:else if filtered.length === 0}
    <EmptyState icon="👥" title="No users" description={q || roleFilter !== 'all' ? `No users match ${q ? `"${q}"` : ''} ${roleFilter !== 'all' ? `role=${roleFilter}` : ''}.` : 'No users registered yet.'} />
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-xs uppercase tracking-wider text-muted">
          <tr class="border-b border-border">
            <th class="w-8 py-2 text-left">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onchange={(e) => toggleAllVisible((e.target as HTMLInputElement).checked)}
                aria-label="Select all on page"
                class="h-4 w-4 rounded border-border bg-surface text-primary focus:ring-primary"
              />
            </th>
            <th class="py-2 text-left font-semibold">
              <button onclick={() => toggleSort('username')} class="inline-flex items-center gap-1 hover:text-text">
                Username {sortKey === 'username' ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
              </button>
            </th>
            <th class="py-2 text-left font-semibold">
              <button onclick={() => toggleSort('email')} class="inline-flex items-center gap-1 hover:text-text">
                Email {sortKey === 'email' ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
              </button>
            </th>
            <th class="py-2 text-left font-semibold">
              <button onclick={() => toggleSort('roles')} class="inline-flex items-center gap-1 hover:text-text">
                Roles {sortKey === 'roles' ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
              </button>
            </th>
            <th class="py-2 text-left font-semibold hidden sm:table-cell">
              <button onclick={() => toggleSort('createdAt')} class="inline-flex items-center gap-1 hover:text-text">
                Created {sortKey === 'createdAt' ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
              </button>
            </th>
            <th class="py-2 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each paged as u (u.id)}
            <tr class="border-b border-border/40 hover:bg-surface/40 {selected.has(u.id) ? 'bg-primary/5' : ''}">
              <td class="py-2">
                <input
                  type="checkbox"
                  checked={selected.has(u.id)}
                  onchange={(e) => toggleOne(u.id, (e.target as HTMLInputElement).checked)}
                  aria-label="Select {u.username}"
                  class="h-4 w-4 rounded border-border bg-surface text-primary focus:ring-primary"
                />
              </td>
              <td class="py-2 font-medium text-text">{u.username}</td>
              <td class="py-2 text-muted">{u.email}</td>
              <td class="py-2">
                <div class="flex flex-wrap gap-1">
                  {#each u.roles as role}
                    <StatusBadge label={role} tone={role === 'admin' ? 'primary' : 'muted'} size="sm" />
                  {/each}
                </div>
              </td>
              <td class="py-2 text-xs text-muted hidden sm:table-cell">
                {u.createdAt ? new Date(u.createdAt * 1000).toLocaleDateString() : '—'}
              </td>
              <td class="py-2 text-right">
                <a href="#/users/{u.id}" class="text-xs text-primary hover:underline">View →</a>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Pagination — Django paginator -->
    <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
      <div>{filtered.length} users • page {page} of {totalPages} • {selected.size} selected</div>
      <div class="flex items-center gap-1">
        <button onclick={() => (page = 1)} disabled={page === 1} class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40">«</button>
        <button onclick={() => (page = Math.max(1, page - 1))} disabled={page === 1} class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40">‹</button>
        <span class="px-2">{page} / {totalPages}</span>
        <button onclick={() => (page = Math.min(totalPages, page + 1))} disabled={page === totalPages} class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40">›</button>
        <button onclick={() => (page = totalPages)} disabled={page === totalPages} class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40">»</button>
      </div>
    </div>
  {/if}
</Card>

<ConfirmDialog
  open={showBulkConfirm}
  title="Delete selected users?"
  message={`Are you sure you want to delete ${selected.size} selected user${selected.size === 1 ? '' : 's'}? This will permanently remove their networks, sessions, preferences, and uploads. This cannot be undone.`}
  confirmLabel={bulkDeleting ? 'Deleting…' : `Delete ${selected.size} user${selected.size === 1 ? '' : 's'}`}
  cancelLabel="Cancel"
  tone="danger"
  onConfirm={confirmBulkDelete}
  onCancel={() => (showBulkConfirm = false)}
/>
