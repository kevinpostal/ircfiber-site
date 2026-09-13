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
  import Ircd from './pages/Ircd.svelte';
  import Motd from './pages/Motd.svelte';
  import Sessions from './pages/Sessions.svelte';
  import Bouncer from './pages/Bouncer.svelte';
  import Users from './pages/Users.svelte';
  import UserNew from './pages/UserNew.svelte';
  import UserDetail from './pages/UserDetail.svelte';
  import Uploads from './pages/Uploads.svelte';
  import Support from './pages/Support.svelte';
  import SupportDetail from './pages/SupportDetail.svelte';
  import MongoMonitor from './pages/MongoMonitor.svelte';
  import RedisMonitor from './pages/RedisMonitor.svelte';
  import Replication from './pages/Replication.svelte';
  import Logs from './pages/Logs.svelte';
  import Version from './pages/Version.svelte';
  import Mullvad from './pages/Mullvad.svelte';
  import Backups from './pages/Backups.svelte';
  import Emails from './pages/Emails.svelte';
  import OAuth from './pages/OAuth.svelte';
  import Embedding from './pages/Embedding.svelte';
  import FiberEye from './pages/FiberEye.svelte';
  import FiberEyeIp from './pages/FiberEyeIp.svelte';
  import ToastViewport from './components/ToastViewport.svelte';
  import { current, onChange, navigate, match } from './lib/router';
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
    if (match('/ircd', path)) return { kind: 'ircd' } as const;
    if (match('/motd', path)) return { kind: 'motd' } as const;
    if (match('/mullvad', path)) return { kind: 'mullvad' } as const;
    if (match('/backups', path)) return { kind: 'backups' } as const;
    if (match('/emails', path)) return { kind: 'emails' } as const;
    if (match('/oauth', path)) return { kind: 'oauth' } as const;
    if (match('/embedding', path)) return { kind: 'embedding' } as const;
    const eyeIpMatch = match('/fibereye/ip/:ip', path);
    if (eyeIpMatch) return { kind: 'fibereye-ip', ip: decodeURIComponent(eyeIpMatch.ip) } as const;
    if (match('/fibereye', path)) return { kind: 'fibereye' } as const;
    if (match('/replication', path)) return { kind: 'replication' } as const;
    if (match('/sessions', path)) return { kind: 'sessions' } as const;
    if (match('/bouncer', path)) return { kind: 'bouncer' } as const;
    const supportMatch = match('/support/:id', path);
    if (supportMatch) return { kind: 'support-detail', issueId: supportMatch.id } as const;
    if (match('/support', path)) return { kind: 'support' } as const;
    if (match('/users/new', path)) return { kind: 'users-new' } as const;
    const usersMatch = match('/users/:id', path);
    if (usersMatch) return { kind: 'users-detail', userId: usersMatch.id } as const;
    if (match('/users', path)) return { kind: 'users' } as const;
    if (match('/uploads', path)) return { kind: 'uploads' } as const;
    if (match('/mongo', path)) return { kind: 'mongo' } as const;
    if (match('/redis', path)) return { kind: 'redis' } as const;
    if (match('/logs', path)) return { kind: 'logs' } as const;
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
      {:else if page?.kind === 'ircd'}
        <Ircd />
      {:else if page?.kind === 'motd'}
        <Motd />
      {:else if page?.kind === 'mullvad'}
        <Mullvad />
      {:else if page?.kind === 'backups'}
        <Backups />
      {:else if page?.kind === 'emails'}
        <Emails />
      {:else if page?.kind === 'oauth'}
        <OAuth />
      {:else if page?.kind === 'embedding'}
        <Embedding />
      {:else if page?.kind === 'replication'}
        <Replication />
      {:else if page?.kind === 'sessions'}
        <Sessions />
      {:else if page?.kind === 'bouncer'}
        <Bouncer />
      {:else if page?.kind === 'logs'}
        <Logs />
      {:else if page?.kind === 'fibereye-ip'}
        <FiberEyeIp ip={page.ip} />
      {:else if page?.kind === 'fibereye'}
        <FiberEye />
      {:else if page?.kind === 'users-new'}
        <UserNew />
      {:else if page?.kind === 'users-detail'}
        <UserDetail userId={page.userId} />
      {:else if page?.kind === 'users'}
        <Users />
      {:else if page?.kind === 'uploads'}
        <Uploads />
      {:else if page?.kind === 'support-detail'}
        <SupportDetail issueId={page.issueId} />
      {:else if page?.kind === 'support'}
        <Support />
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
