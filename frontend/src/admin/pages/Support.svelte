<script lang="ts">
  /**
   * Support page — Help & Feedback reports from every account.
   * Fetches from /api/admin/support/issues with status/kind/search filters
   * and pagination; rows link to the triage view (#/support/:id).
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { relative, truncate } from '../lib/format';
  import { STATUS_LABELS, STATUS_TONES, KIND_LABELS, type SupportRow, type SupportStatus, type SupportKind } from '../lib/support';

  interface SupportListResponse {
    issues: SupportRow[];
    total: number;
    page: number;
    limit: number;
    counts: Record<SupportStatus, number>;
  }

  type StatusFilter = 'active' | SupportStatus | 'all';

  let data = $state<SupportListResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let statusFilter = $state<StatusFilter>('active');
  let kindFilter = $state<'' | SupportKind>('');
  let q = $state('');
  let page = $state(0);
  const perPage = 50;
  const totalPages = $derived(data?.total ? Math.ceil(data.total / perPage) : 0);
  const counts = $derived(data?.counts ?? { open: 0, in_progress: 0, resolved: 0, closed: 0 });

  const statusTabs: { key: StatusFilter; label: string; count: () => number }[] = [
    { key: 'active', label: 'Active', count: () => counts.open + counts.in_progress },
    { key: 'open', label: 'Open', count: () => counts.open },
    { key: 'in_progress', label: 'In progress', count: () => counts.in_progress },
    { key: 'resolved', label: 'Resolved', count: () => counts.resolved },
    { key: 'closed', label: 'Closed', count: () => counts.closed },
    { key: 'all', label: 'All', count: () => counts.open + counts.in_progress + counts.resolved + counts.closed },
  ];

  onMount(() => fetchData());

  async function fetchData() {
    loading = true; error = null;
    try {
      data = await api.get<SupportListResponse>('/api/admin/support/issues', {
        page,
        limit: perPage,
        status: statusFilter === 'active' ? undefined : statusFilter,
        kind: kindFilter || undefined,
        q: q.trim() || undefined,
      });
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  function setStatus(s: StatusFilter) {
    statusFilter = s;
    page = 0;
    fetchData();
  }

  function setKind(e: Event) {
    kindFilter = (e.target as HTMLSelectElement).value as '' | SupportKind;
    page = 0;
    fetchData();
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onSearch(e: Event) {
    q = (e.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { page = 0; fetchData(); }, 300);
  }

  function goToPage(p: number) {
    page = p;
    fetchData();
  }

  function priorityClass(p: string): string {
    if (p === 'urgent') return 'text-danger font-semibold';
    if (p === 'high') return 'text-warn font-semibold';
    if (p === 'low') return 'text-muted';
    return 'text-text';
  }
</script>

<PageHeader title="Support" subtitle={`${counts.open} open · ${counts.in_progress} in progress · ${counts.resolved} resolved`} />

{#if error}
  <Card class="mb-4"><div class="text-sm text-danger">{error}</div></Card>
{/if}

<div class="mb-4 flex flex-wrap items-center gap-2">
  {#each statusTabs as tab (tab.key)}
    <button
      type="button"
      onclick={() => setStatus(tab.key)}
      aria-pressed={statusFilter === tab.key}
      class="rounded-md border px-3 py-1.5 text-xs font-medium {statusFilter === tab.key
        ? 'border-primary bg-primary text-primary-fg'
        : 'border-border bg-surface text-text hover:border-primary/40'}">
      {tab.label} <span class="opacity-70">({tab.count()})</span>
    </button>
  {/each}
  <select
    aria-label="Kind"
    value={kindFilter}
    onchange={setKind}
    class="ml-auto rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text focus:border-primary focus:outline-none">
    <option value="">Any kind</option>
    {#each Object.entries(KIND_LABELS) as [value, label] (value)}
      <option {value}>{label}</option>
    {/each}
  </select>
  <input
    type="search"
    placeholder="Search title or reporter"
    value={q}
    oninput={onSearch}
    class="w-56 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text focus:border-primary focus:outline-none" />
</div>

<Card>
  {#if loading && !data}
    <div class="flex h-32 items-center justify-center">
      <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
    </div>
  {:else if !data?.issues?.length}
    <EmptyState icon="🎫" title="No issues" description="Nothing matches this filter." />
  {:else}
    <table class="w-full text-sm">
      <thead class="text-xs uppercase tracking-wider text-muted">
        <tr class="border-b border-border">
          <th class="py-2 text-left font-semibold">#</th>
          <th class="py-2 text-left font-semibold">Title</th>
          <th class="py-2 text-left font-semibold hidden md:table-cell">Kind</th>
          <th class="py-2 text-left font-semibold">Status</th>
          <th class="py-2 text-left font-semibold hidden lg:table-cell">Priority</th>
          <th class="py-2 text-left font-semibold">Reporter</th>
          <th class="py-2 text-left font-semibold hidden lg:table-cell">Assignee</th>
          <th class="py-2 text-right font-semibold hidden md:table-cell">Comments</th>
          <th class="py-2 text-right font-semibold hidden lg:table-cell">Created</th>
        </tr>
      </thead>
      <tbody>
        {#each data.issues as issue (issue.id)}
          <tr class="border-b border-border/40 hover:bg-surface/40">
            <td class="py-2 font-mono text-xs text-muted">#{issue.number}</td>
            <td class="py-2">
              <a href="#/support/{issue.id}" class="font-medium text-text hover:text-primary hover:underline">{truncate(issue.title, 70)}</a>
            </td>
            <td class="py-2 hidden md:table-cell">
              <StatusBadge label={KIND_LABELS[issue.kind] ?? issue.kind} tone="info" dot={false} size="sm" />
            </td>
            <td class="py-2">
              <StatusBadge label={STATUS_LABELS[issue.status] ?? issue.status} tone={STATUS_TONES[issue.status] ?? 'muted'} size="sm" />
            </td>
            <td class="py-2 hidden lg:table-cell text-xs {priorityClass(issue.priority)}">{issue.priority}</td>
            <td class="py-2">
              <a href="#/users/{issue.userId}" class="text-primary hover:underline">{issue.reporterUsername || 'unknown'}</a>
            </td>
            <td class="py-2 hidden lg:table-cell text-xs text-muted">{issue.assigneeUsername || '—'}</td>
            <td class="py-2 text-right hidden md:table-cell font-mono text-xs text-muted">{issue.commentCount}</td>
            <td class="py-2 text-right hidden lg:table-cell text-xs text-muted">{relative(issue.createdAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <!-- Pagination -->
    {#if totalPages > 1}
      <div class="mt-4 flex items-center justify-center gap-2">
        <button
          type="button"
          onclick={() => goToPage(page - 1)}
          disabled={page <= 0}
          class="rounded border border-border bg-surface px-3 py-1 text-xs font-medium text-text hover:border-primary/40 disabled:opacity-30">
          ← Prev
        </button>
        <span class="text-xs text-muted">
          Page {page + 1} of {totalPages}
        </span>
        <button
          type="button"
          onclick={() => goToPage(page + 1)}
          disabled={page >= totalPages - 1}
          class="rounded border border-border bg-surface px-3 py-1 text-xs font-medium text-text hover:border-primary/40 disabled:opacity-30">
          Next →
        </button>
      </div>
    {/if}
  {/if}
</Card>
