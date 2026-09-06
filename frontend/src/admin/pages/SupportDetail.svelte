<script lang="ts">
  /**
   * SupportDetail — triage one Help & Feedback report.
   * Route: /support/:id. Status / priority / assignee, the reporter's
   * report with attachments + diagnostics, a two-way conversation (public
   * replies are announced in #support and shown to the reporter; internal
   * notes are admin-only), and permanent delete.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { navigate } from '../lib/router';
  import { relative } from '../lib/format';
  import {
    STATUSES, PRIORITIES, STATUS_LABELS, STATUS_TONES, KIND_LABELS, CONTEXT_LABELS,
    type SupportDetail, type SupportStatus, type SupportPriority, type SupportContext,
  } from '../lib/support';

  interface AdminUser { id: string; username: string; roles: string[]; }

  interface Props { issueId: string; }
  let { issueId }: Props = $props();

  let issue = $state<SupportDetail | null>(null);
  let admins = $state<AdminUser[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  // Triage form
  let status = $state<SupportStatus>('open');
  let priority = $state<SupportPriority>('normal');
  let assigneeId = $state('');
  let saving = $state(false);

  // Conversation composer
  let reply = $state('');
  let internal = $state(false);
  let posting = $state(false);

  const kindLabel = $derived(issue ? (KIND_LABELS[issue.kind] ?? issue.kind) : '');
  const contextRows = $derived.by(() => {
    if (!issue?.context) return [] as { label: string; value: string }[];
    return (Object.keys(CONTEXT_LABELS) as (keyof SupportContext)[])
      .filter((k) => issue!.context[k])
      .map((k) => ({ label: CONTEXT_LABELS[k], value: issue!.context[k] }));
  });

  onMount(() => { load(); loadAdmins(); });

  function apply(data: SupportDetail) {
    issue = data;
    status = data.status;
    priority = data.priority;
    assigneeId = data.assigneeId ?? '';
  }

  async function load() {
    loading = true; error = null;
    try {
      apply(await api.get<SupportDetail>(`/api/admin/support/issues/${issueId}`));
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  async function loadAdmins() {
    try {
      const data = await api.get<{ users: AdminUser[] }>('/api/admin/users');
      admins = data.users.filter((u) => u.roles.includes('admin'));
    } catch {
      admins = [];
    }
  }

  async function save(e: Event) {
    e.preventDefault();
    saving = true;
    try {
      apply(await api.post<SupportDetail>(`/api/admin/support/issues/${issueId}`, { status, priority, assigneeId }));
      toastSuccess('Issue updated');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally { saving = false; }
  }

  async function post(e: Event) {
    e.preventDefault();
    const text = reply.trim();
    if (!text) return;
    posting = true;
    try {
      apply(await api.post<SupportDetail>(`/api/admin/support/issues/${issueId}/comments`, { body: text, internal }));
      toastSuccess(internal ? 'Note added' : 'Reply sent');
      reply = '';
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally { posting = false; }
  }

  async function remove() {
    if (!confirm('Delete this issue permanently?')) return;
    try {
      await api.post(`/api/admin/support/issues/${issueId}/delete`);
      toastSuccess('Issue deleted');
      navigate('/support');
    } catch (err) {
      toastError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  function attachmentName(url: string): string {
    return url.slice(url.lastIndexOf('/') + 1) || url;
  }
</script>

{#if loading && !issue}
  <div class="flex h-64 items-center justify-center">
    <div class="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
  </div>
{:else if error}
  <PageHeader title="Support issue" subtitle="Error loading issue" breadcrumbs={[{ label: 'Support', href: '#/support' }]} />
  <Card><div class="text-sm text-danger">{error}</div></Card>
{:else if issue}
  <PageHeader
    title={`#${issue.number} ${issue.title}`}
    subtitle={`${kindLabel} · reported by ${issue.reporterUsername} ${relative(issue.createdAt)}`}
    breadcrumbs={[{ label: 'Support', href: '#/support' }, { label: `#${issue.number}` }]}>
    {#snippet actions()}
      <StatusBadge label={STATUS_LABELS[issue.status] ?? issue.status} tone={STATUS_TONES[issue.status] ?? 'muted'} />
    {/snippet}
  </PageHeader>

  <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
    <div class="space-y-6 lg:col-span-2">
      <!-- Report -->
      <Card title="Report" subtitle={`${kindLabel} · ${issue.priority} priority`}>
        <p class="whitespace-pre-wrap break-words text-sm text-text">{issue.body}</p>
        {#if issue.attachments.length}
          <div class="mt-4 flex flex-wrap gap-3">
            {#each issue.attachments as url (url)}
              <a href={url} target="_blank" rel="noopener" title={attachmentName(url)}>
                <img src={url} alt={attachmentName(url)} class="h-24 rounded border border-border object-cover" />
              </a>
            {/each}
          </div>
        {/if}
        <dl class="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt class="text-muted">Reporter</dt>
          <dd class="text-text">
            <a href="#/users/{issue.userId}" class="text-primary hover:underline">{issue.reporterUsername}</a>
            {#if issue.reporterEmail}<span class="text-muted"> · {issue.reporterEmail}</span>{/if}
          </dd>
          {#each contextRows as row (row.label)}
            <dt class="text-muted">{row.label}</dt>
            <dd class="break-all font-mono text-text">{row.value}</dd>
          {/each}
        </dl>
      </Card>

      <!-- Conversation -->
      <Card title="Conversation" subtitle={`${issue.comments.length} ${issue.comments.length === 1 ? 'comment' : 'comments'}`}>
        {#if issue.comments.length}
          <ul class="mb-4 space-y-3">
            {#each issue.comments as c (c.id)}
              <li class="rounded-md border border-border bg-surface/50 px-4 py-2 {c.internal ? 'border-l-2 border-l-warn' : ''}">
                <div class="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span class="font-semibold text-text">{c.authorName}</span>
                  {#if c.fromAdmin}<StatusBadge label="admin" tone="primary" size="sm" dot={false} />{/if}
                  {#if c.internal}<StatusBadge label="Internal" tone="warn" size="sm" dot={false} />{/if}
                  <span>{relative(c.createdAt)}</span>
                </div>
                <p class="whitespace-pre-wrap break-words text-sm text-text">{c.body}</p>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mb-4 text-sm text-muted">No comments yet.</p>
        {/if}
        <form onsubmit={post} class="space-y-2">
          <label for="reply" class="block text-xs font-semibold uppercase tracking-wider text-muted">Reply</label>
          <textarea id="reply" rows="3" bind:value={reply} maxlength="5000"
            placeholder={internal ? 'Internal note (not shown to the reporter)' : 'Reply to the reporter'}
            class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none"></textarea>
          <div class="flex flex-wrap items-center gap-3">
            <label class="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" id="internal" bind:checked={internal} />
              Internal note — hidden from the reporter
            </label>
            <button type="submit" disabled={posting || !reply.trim()}
              class="ml-auto rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
              {posting ? 'Posting…' : internal ? 'Add note' : 'Post reply'}
            </button>
          </div>
        </form>
      </Card>
    </div>

    <div class="space-y-6">
      <!-- Triage -->
      <Card title="Triage" subtitle="Status changes are announced in #support">
        <form onsubmit={save} class="space-y-3">
          <div>
            <label for="status" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Status</label>
            <select id="status" bind:value={status}
              class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none">
              {#each STATUSES as s (s)}
                <option value={s}>{STATUS_LABELS[s]}</option>
              {/each}
            </select>
          </div>
          <div>
            <label for="priority" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Priority</label>
            <select id="priority" bind:value={priority}
              class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none">
              {#each PRIORITIES as p (p)}
                <option value={p}>{p}</option>
              {/each}
            </select>
          </div>
          <div>
            <label for="assignee" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Assignee</label>
            <select id="assignee" bind:value={assigneeId}
              class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none">
              <option value="">Unassigned</option>
              {#each admins as a (a.id)}
                <option value={a.id}>{a.username}</option>
              {/each}
            </select>
          </div>
          <button type="submit" disabled={saving}
            class="w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
        <dl class="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt class="text-muted">Created</dt><dd class="text-text">{relative(issue.createdAt)}</dd>
          <dt class="text-muted">Updated</dt><dd class="text-text">{relative(issue.updatedAt)}</dd>
          <dt class="text-muted">Resolved</dt><dd class="text-text">{issue.resolvedAt > 0 ? relative(issue.resolvedAt) : '—'}</dd>
        </dl>
      </Card>

      <!-- Danger zone -->
      <Card title="Danger zone" subtitle="Removes the report and its conversation">
        <button type="button" onclick={remove}
          class="rounded-md border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20">
          Delete issue
        </button>
      </Card>
    </div>
  </div>
{/if}
