<script lang="ts">
  /**
   * Uploads page — all user-uploaded files across every account.
   * Fetches from /api/admin/uploads with pagination.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { navigate } from '../lib/router';
  import { relative } from '../lib/format';

  interface UploadEntry {
    id: string;
    userId: string;
    username: string;
    filename: string;
    buffer: string;
    mimeType: string;
    size: number;
    directUrl: string;
    createdAt: number;
  }

  interface UploadsResponse {
    uploads: UploadEntry[];
    total: number;
    page: number;
    limit: number;
  }

  let data = $state<UploadsResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let page = $state(0);
  let perPage = $state(50);
  let totalPages = $derived(data?.total ? Math.ceil(data.total / perPage) : 0);

  onMount(() => fetchData());

  async function fetchData() {
    loading = true; error = null;
    try {
      data = await api.get<UploadsResponse>('/api/admin/uploads', { page, limit: perPage });
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  async function deleteUpload(id: string) {
    if (!confirm('Delete this upload? The file and its database record will be permanently removed.')) return;
    try {
      await api.post(`/api/admin/uploads/${id}/delete`);
      toastSuccess('Upload deleted');
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  function fmtSize(s: number): string {
    if (s >= 1048576) return `${(s / 1048576).toFixed(1)} MB`;
    if (s >= 1024) return `${(s / 1024).toFixed(1)} KB`;
    return `${s} B`;
  }

  function isImage(mime: string): boolean {
    return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);
  }

  function goToPage(p: number) {
    page = p;
    fetchData();
  }
</script>

<PageHeader title="Uploads" subtitle={`${data?.total ?? 0} files across all accounts`} />

{#if error}
  <Card class="mb-4"><div class="text-sm text-danger">{error}</div></Card>
{/if}

<Card>
  {#if loading && !data}
    <div class="flex h-32 items-center justify-center">
      <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
    </div>
  {:else if !data?.uploads?.length}
    <EmptyState icon="📎" title="No uploads" description="No files have been uploaded yet." />
  {:else}
    <table class="w-full text-sm">
      <thead class="text-xs uppercase tracking-wider text-muted">
        <tr class="border-b border-border">
          <th class="py-2 text-left font-semibold">File</th>
          <th class="py-2 text-left font-semibold">User</th>
          <th class="py-2 text-left font-semibold hidden md:table-cell">Type</th>
          <th class="py-2 text-right font-semibold">Size</th>
          <th class="py-2 text-right font-semibold hidden lg:table-cell">Uploaded</th>
          <th class="py-2 text-right font-semibold">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each data.uploads as upload (upload.id)}
          <tr class="border-b border-border/40 hover:bg-surface/40">
            <td class="py-2">
              <div class="flex items-center gap-2">
                {#if upload.directUrl && isImage(upload.mimeType)}
                  <img src={upload.directUrl} alt={upload.filename}
                    class="h-8 w-8 shrink-0 rounded border border-border object-cover" />
                {:else}
                  <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border text-xs text-muted">📎</div>
                {/if}
                <div class="min-w-0">
                  <div class="truncate font-medium text-text max-w-[200px]">{upload.filename}</div>
                  {#if upload.buffer}
                    <div class="text-[11px] text-muted">#{upload.buffer}</div>
                  {/if}
                </div>
              </div>
            </td>
            <td class="py-2">
              <a href="#/users/{upload.userId}" class="text-primary hover:underline">{upload.username || 'unknown'}</a>
            </td>
            <td class="py-2 hidden md:table-cell text-muted text-xs">{upload.mimeType}</td>
            <td class="py-2 text-right font-mono text-muted text-xs">{fmtSize(upload.size)}</td>
            <td class="py-2 text-right hidden lg:table-cell text-muted text-xs">
              {upload.createdAt > 0 ? relative(upload.createdAt) : '—'}
            </td>
            <td class="py-2 text-right whitespace-nowrap">
              {#if upload.directUrl}
                <a href={upload.directUrl} target="_blank"
                  class="rounded border border-border bg-surface px-2 py-1 text-[11px] font-medium text-text hover:border-primary/40">
                  View
                </a>
              {/if}
              <button
                type="button"
                onclick={() => deleteUpload(upload.id)}
                class="ml-1 rounded border border-danger/30 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10">
                Delete
              </button>
            </td>
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