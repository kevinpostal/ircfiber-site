<script lang="ts">
  /**
   * Admin App shell — sidebar + topbar + routed page.
   *
   * Routing is hash-based (no SvelteKit). Each page subscribes to the
   * `current()` path via the lightweight router in `lib/router.ts`.
   * The whole admin runs in a single mounted component — keeps the
   * bundle small and avoids SvelteKit's overhead for what is, at heart,
   * a single-page CRUD app.
   */
  import { onMount, onDestroy } from 'svelte';
  import AdminSidebar from './shell/AdminSidebar.svelte';
  import AdminTopbar from './shell/AdminTopbar.svelte';
  import Dashboard from './pages/Dashboard.svelte';
  import Servers from './pages/Servers.svelte';
  import ServerHost from './pages/ServerHost.svelte';
  import Sessions from './pages/Sessions.svelte';
  import Users from './pages/Users.svelte';
  import UserNew from './pages/UserNew.svelte';
  import UserDetail from './pages/UserDetail.svelte';
  import Uploads from './pages/Uploads.svelte';
  import MongoMonitor from './pages/MongoMonitor.svelte';
  import RedisMonitor from './pages/RedisMonitor.svelte';
  import Logs from './pages/Logs.svelte';
  import Version from './pages/Version.svelte';
  import ToastViewport from './components/ToastViewport.svelte';
  import { adminUser, loadMe } from './stores/auth';

  let path = $state(current());
  let ready = $state(false);
  let unsub = () => {};

  onMount(() => {
    unsub = onChange((p) => { path = p; });
    loadMe().finally(() => { ready = true; });
    // Redirect bare #/ to dashboard
    if (path === '/' || path === '') navigate('/dashboard');
  });
  onDestroy(() => unsub());

  // Resolve which page to render. Match is order-sensitive: most specific first.
  const page = $derived.by(() => {
    if (!ready) return null;
    if (match('/dashboard', path) || path === '/' || path === '') return { kind: 'dashboard' } as const;
    const hostMatch = match('/servers/host/:host', path);
    if (hostMatch) return { kind: 'servers-host', host: hostMatch.host } as const;
    if (match('/servers', path)) return { kind: 'servers' } as const;
    if (match('/sessions', path)) return { kind: 'sessions' } as const;
    if (match('/logs', path)) return { kind: 'logs' } as const;
    if (match('/users/new', path)) return { kind: 'users-new' } as const;
    const usersMatch = match('/users/:id', path);
    if (usersMatch) return { kind: 'users-detail', userId: usersMatch.id } as const;
    if (match('/users', path)) return { kind: 'users' } as const;
    if (match('/uploads', path)) return { kind: 'uploads' } as const;
    if (match('/mongo', path)) return { kind: 'mongo' } as const;
    if (match('/redis', path)) return { kind: 'redis' } as const;
    if (match('/version', path)) return { kind: 'version' } as const;
    return { kind: 'notfound' } as const;
  });
</script>

<div class="flex h-screen overflow-hidden bg-bg">
  <AdminSidebar />
  <div class="flex min-w-0 flex-1 flex-col">
    <AdminTopbar />
    <main class="flex-1 overflow-y-auto p-6">
      {#if !ready}
        <div class="flex h-full items-center justify-center">
          <div class="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
        </div>
      {:else if page?.kind === 'dashboard'}
        <Dashboard />
      {:else if page?.kind === 'servers-host'}
        <ServerHost host={page.host} />
      {:else if page?.kind === 'servers'}
        <Servers />
      {:else if page?.kind === 'sessions'}
        <Sessions />
      {:else if page?.kind === 'logs'}
        <Logs />
      {:else if page?.kind === 'users-new'}
        <UserNew />
      {:else if page?.kind === 'users-detail'}
        <UserDetail userId={page.userId} />
      {:else if page?.kind === 'users'}
        <Users />
      {:else if page?.kind === 'uploads'}
        <Uploads />
      {:else if page?.kind === 'mongo'}
        <MongoMonitor />
      {:else if page?.kind === 'redis'}
        <RedisMonitor />
      {:else if page?.kind === 'version'}
        <Version />
      {:else}
        <div class="text-center">
          <h2 class="text-xl font-semibold text-heading">Page not found</h2>
          <p class="mt-2 text-sm text-muted">No view registered for <code>{path}</code></p>
          <button onclick={() => navigate('/dashboard')} class="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg hover:bg-primary/90">
            Go to Dashboard
          </button>
        </div>
      {/if}
    </main>
  </div>
</div>

<ToastViewport />