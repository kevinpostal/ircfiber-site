<script lang="ts">
  /**
   * AdminSidebar — nav links grouped by section.
   * Sections: Operations, People, Data.
   */
  import { onMount, onDestroy } from 'svelte';
  import { current, onChange, href } from '../lib/router';
  import { sidebarCollapsed } from '../stores/ui';
  import { BUILD_INFO } from '../../lib/buildInfo';

  interface NavItem {
    label: string;
    path: string;
    icon: string;
    badge?: string;
  }
  interface NavSection {
    label: string;
    items: NavItem[];
  }

  const sections: NavSection[] = [
    {
      label: 'Overview',
      items: [
        { label: 'Dashboard', path: '/dashboard', icon: '📊' },
        { label: 'Version', path: '/version', icon: '🏷️' },
      ],
    },
    {
      label: 'Operations',
      items: [
        { label: 'Servers', path: '/servers', icon: '🖥️' },
        { label: 'Mullvad', path: '/mullvad', icon: '🛡️' },
        { label: 'Replication', path: '/replication', icon: '🔗' },
        { label: 'Sessions', path: '/sessions', icon: '🔑' },
        { label: 'Bouncer', path: '/bouncer', icon: '🔌' },
        { label: 'Logs', path: '/logs', icon: '📜' },
      ],
    },
    {
      label: 'Data',
      items: [
        { label: 'MongoDB', path: '/mongo', icon: '🍃' },
        { label: 'Redis', path: '/redis', icon: '🔴' },
      ],
    },
    {
      label: 'People',
      items: [
        { label: 'Users', path: '/users', icon: '👥' },
        { label: 'Uploads', path: '/uploads', icon: '📎' },
      ],
    },
  ];

  let currentPath = $state(current());
  let stop: (() => void) | null = null;

  onMount(() => {
    stop = onChange((p) => { currentPath = p; });
  });
  onDestroy(() => stop?.());

  function isActive(path: string): boolean {
    const cur = currentPath;
    if (path === '/dashboard') return cur === '/' || cur === '/dashboard';
    return cur === path || cur.startsWith(path + '/');
  }
</script>

<aside
  class="flex h-full shrink-0 flex-col border-r border-border bg-sidebar-bg text-sidebar-fg transition-all duration-200 {$sidebarCollapsed ? 'w-16' : 'w-60'}"
>
  <div class="flex h-14 items-center border-b border-border px-4">
    <span class="text-lg font-bold tracking-tight text-primary">⚡ IRC Fiber</span>
  </div>

  <nav class="flex-1 overflow-y-auto px-2 py-4">
    {#each sections as section}
      <div class="mb-4">
        {#if !$sidebarCollapsed}
          <div class="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted">{section.label}</div>
        {/if}
        {#each section.items as item}
          <a
            href={href(item.path)}
            class="group flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition {isActive(item.path) ? 'bg-primary/10 font-semibold text-sidebar-active' : 'text-sidebar-fg hover:bg-border/40'}"
            title={item.label}
          >
            <span class="text-base">{item.icon}</span>
            {#if !$sidebarCollapsed}
              <span class="flex-1 truncate">{item.label}</span>
              {#if item.badge}
                <span class="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{item.badge}</span>
              {/if}
            {/if}
          </a>
        {/each}
      </div>
    {/each}
  </nav>

  <div class="border-t border-border px-3 py-2 text-[10px] font-mono text-muted">
    {#if !$sidebarCollapsed}
      <a href="#/version" class="flex items-center gap-1.5 hover:text-text" title="View build versions">
        <span class="h-2 w-2 rounded-full bg-success"></span>
        <span>frontend {BUILD_INFO.short}</span>
      </a>
      <div class="mt-1 text-[9px] leading-none">tap for gateway + engines</div>
    {:else}
      <a href="#/version" class="flex justify-center" title="Version"><span class="text-[10px]">🏷️</span></a>
    {/if}
  </div>

  <button
    type="button"
    onclick={() => sidebarCollapsed.update((v) => !v)}
    class="flex h-10 items-center justify-center border-t border-border text-xs text-muted transition hover:bg-border/40"
    title={$sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
  >
    {$sidebarCollapsed ? '→' : '← Collapse'}
  </button>
</aside>