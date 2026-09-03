<script lang="ts">
  /**
   * AdminTopbar — page context, refresh toggle, theme toggle, user menu.
   */
  import ThemeToggle from '../components/ThemeToggle.svelte';
  import RefreshIndicator from '../components/RefreshIndicator.svelte';
  import VersionBadge from '../components/VersionBadge.svelte';
  import { adminUser, logout } from '../stores/auth';
  import { current } from '../lib/router';

  interface Props {
    lastFetchedAt?: number | null;
    loading?: boolean;
  }
  let { lastFetchedAt = null, loading = false }: Props = $props();

  let menuOpen = $state(false);
  const titleMap: Record<string, string> = {
    '/': 'Dashboard',
    '/dashboard': 'Dashboard',
    '/servers': 'Servers & Routing',
    '/ircd': 'IRCD',
    '/sessions': 'Sessions',
    '/users': 'Users',
    '/uploads': 'Uploads',
    '/mongo': 'MongoDB Monitor',
    '/redis': 'Redis Monitor',
  };
  const pageTitle = $derived.by(() => {
    const cur = current();
    if (titleMap[cur]) return titleMap[cur];
    for (const prefix of Object.keys(titleMap)) {
      if (cur.startsWith(prefix + '/')) return titleMap[prefix];
    }
    return 'Admin';
  });
</script>

<header class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-6">
  <div class="flex min-w-0 flex-1 items-center gap-3">
    <h1 class="truncate text-lg font-semibold text-heading">{pageTitle}</h1>
    <span class="rounded-md bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">Admin</span>
  </div>
  <div class="flex items-center gap-2">
    <VersionBadge />
    <RefreshIndicator {lastFetchedAt} {loading} />
    <ThemeToggle />

    {#if $adminUser}
      <div class="relative">
        <button
          type="button"
          onclick={() => menuOpen = !menuOpen}
          class="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm transition hover:border-primary/40"
        >
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">
            {$adminUser.username.charAt(0).toUpperCase()}
          </span>
          <span class="font-medium text-text">{$adminUser.username}</span>
          <span class="text-xs text-muted">▾</span>
        </button>
        {#if menuOpen}
          <button
            type="button"
            class="fixed inset-0 z-40 cursor-default"
            onclick={() => menuOpen = false}
            aria-label="Close menu"
          ></button>
          <div class="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-surface py-1 shadow-lg">
            <div class="border-b border-border px-3 py-2 text-xs text-muted">
              <div class="font-medium text-text">{$adminUser.username}</div>
              <div class="truncate">{$adminUser.email}</div>
              <div class="mt-1 flex flex-wrap gap-1">
                {#each $adminUser.roles as role}
                  <span class="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">{role}</span>
                {/each}
              </div>
            </div>
            <a href="/" target="_blank" class="block px-3 py-2 text-sm text-text hover:bg-surface-2">View site →</a>
            <button type="button" onclick={logout} class="block w-full px-3 py-2 text-left text-sm text-danger hover:bg-surface-2">Log out</button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</header>