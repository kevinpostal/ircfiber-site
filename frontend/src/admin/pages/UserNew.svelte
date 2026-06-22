<script lang="ts">
  /**
   * UserNew — create a new user account.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { navigate } from '../lib/router';

  let username = $state('');
  let email = $state('');
  let password = $state('');
  let submitting = $state(false);
  let error = $state<string | null>(null);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    submitting = true; error = null;
    try {
      const res = await api.post<{ id: string; username: string }>('/api/admin/users', { username, email, password });
      toastSuccess(`Created user ${res.username}`);
      navigate(`/users/${res.id}`);
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { submitting = false; }
  }
</script>

<PageHeader title="Create User" subtitle="Add a new IRC Fiber account" />

{#if error}
  <Card class="mb-4">
    <div class="text-sm text-danger">{error}</div>
  </Card>
{/if}

<Card class="max-w-lg">
  <form onsubmit={handleSubmit} class="space-y-4">
    <div>
      <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Username</label>
      <input type="text" bind:value={username} required autofocus
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none" />
    </div>
    <div>
      <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Email</label>
      <input type="email" bind:value={email} required
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none" />
    </div>
    <div>
      <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Password</label>
      <input type="password" bind:value={password} required
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none" />
    </div>
    <div class="flex items-center gap-2 pt-2">
      <button type="submit" disabled={submitting}
        class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
        {submitting ? 'Creating…' : 'Create User'}
      </button>
      <a href="#/users" class="text-sm text-muted hover:text-text">Cancel</a>
    </div>
  </form>
</Card>