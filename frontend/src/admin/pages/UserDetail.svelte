<script lang="ts">
  /**
   * UserDetail — view/edit user, networks, uploads, IPs, reset password.
   * Route: /users/:id — id comes from the hash router params.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import FilterHorizontal from '../components/FilterHorizontal.svelte';
  import { adminUser } from '../stores/auth';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { navigate } from '../lib/router';
  import { bytes, relative } from '../lib/format';

  interface NetworkData {
    id: string;
    name: string;
    host: string;
    port: number;
    nick: string;
    disabled: boolean;
    connected: boolean;
    currentNick: string;
    autoJoinChannels: string[];
    tls: string;
    sasl: string;
  }

  interface UploadData {
    id: string;
    filename: string;
    buffer: string;
    mimeType: string;
    size: number;
    directUrl: string;
    createdAt: number;
  }

  interface UserDetailData {
    id: string;
    username: string;
    email: string;
    roles: string[];
    signupIp: string;
    lastLoginIp: string;
    loginIps: string[];
    createdAt: number;
    uploadCount: number;
    networks: NetworkData[];
    uploads: UploadData[];
  }

  /** GET /api/admin/roles row — built-ins first, then custom roles seen in the DB. */
  interface RoleInfo {
    name: string;
    description: string;
    builtin: boolean;
    users: number;
  }

  interface Props {
    userId?: string;
  }
  let { userId }: Props = $props();

  let user = $state<UserDetailData | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  // Edit form state
  let editEmail = $state('');
  let editRoles = $state<string[]>([]);
  let roleCatalog = $state<RoleInfo[]>([]);
  const roleOptions = $derived.by(() => {
    // Ensure every role the user already has is offered even if the
    // catalogue request failed or the label is unknown to it.
    const known = new Set(roleCatalog.map((r) => r.name));
    const opts = roleCatalog.map((r) => ({ value: r.name, label: r.name, hint: r.description }));
    for (const r of user?.roles ?? []) if (!known.has(r)) opts.push({ value: r, label: r, hint: 'Custom role' });
    return opts;
  });
  // Django won't let you silently lock yourself out; keep `admin` on your
  // own account (the backend additionally refuses to strip the last admin).
  const isSelf = $derived(!!user && !!$adminUser && user.id === $adminUser.id);
  const lockedRoles = $derived(isSelf ? ['admin'] : []);
  const rolesDirty = $derived(!!user && (user.roles.length !== editRoles.length || user.roles.some((r, i) => editRoles[i] !== r)));
  let saving = $state(false);
  let saveMsg = $state<string | null>(null);

  // Reset password
  let newPass = $state('');
  let resetting = $state(false);
  let resetMsg = $state<string | null>(null);

  onMount(() => { loadUser(); loadRoles(); });

  async function loadUser() {
    if (!userId) return;
    loading = true; error = null;
    try {
      const data = await api.get<UserDetailData>(`/api/admin/users/${userId}`);
      user = data;
      editEmail = data.email;
      editRoles = [...data.roles];
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  async function loadRoles() {
    try {
      const data = await api.get<{ roles: RoleInfo[] }>('/api/admin/roles');
      roleCatalog = data.roles;
    } catch {
      roleCatalog = [];
    }
  }

  async function saveUser(e: Event) {
    e.preventDefault();
    if (!user) return;
    saving = true; saveMsg = null;
    try {
      await api.post(`/api/admin/users/${user.id}`, {
        email: editEmail,
        roles: editRoles,
      });
      saveMsg = 'User updated successfully';
      toastSuccess('User saved');
      await loadUser();
    } catch (e) {
      saveMsg = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { saving = false; }
  }

  async function deleteUser() {
    if (!user || !confirm(`Delete user ${user.username}? This will also remove their networks, uploads, sessions, and buffers.`)) return;
    try {
      await api.post(`/api/admin/users/${user.id}/delete`);
      toastSuccess(`Deleted user ${user.username}`);
      navigate('/users');
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function resetPassword(e: Event) {
    e.preventDefault();
    if (!user) return;
    resetting = true; resetMsg = null;
    try {
      await api.post(`/api/admin/users/${user.id}/reset-password`, { password: newPass || 'changeme123' });
      resetMsg = 'Password reset successfully';
      toastSuccess('Password reset');
      newPass = '';
    } catch (e) {
      resetMsg = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { resetting = false; }
  }

  function impersonate() {
    if (!user) return;
    window.location.href = `/admin/users/${user.id}/impersonate`;
  }

  // Size formatting for uploads
  function fmtSize(s: number): string {
    if (s >= 1048576) return `${(s / 1048576).toFixed(1)} MB`;
    if (s >= 1024) return `${(s / 1024).toFixed(1)} KB`;
    return `${s} B`;
  }

  function isImage(mime: string): boolean {
    return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);
  }

  let disconnecting = $state<Set<string>>(new Set());

  async function disconnectNetwork(net: NetworkData) {
    if (!confirm(`Disconnect ${net.name} (${net.host}:${net.port})? The connection will be closed but the network config is kept.`)) return;
    disconnecting.add(net.id);
    try {
      await api.post(`/api/admin/servers/host/${encodeURIComponent(net.host)}/disconnect/${net.id}`);
      // Optimistic update: mark disconnected locally so the UI
      // reflects the change immediately. The engine processes the
      // disconnect asynchronously; without this the reload below
      // would read the stale Redis snapshot that still says
      // connected=true.
      if (user) {
        const netData = user.networks.find(n => n.id === net.id);
        if (netData) {
          netData.connected = false;
          netData.disabled = true;
        }
      }
      toastSuccess(`Disconnected ${net.name}`);
      await loadUser();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      disconnecting.delete(net.id);
    }
  }
</script>

{#if loading}
  <div class="flex h-64 items-center justify-center">
    <div class="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
  </div>
{:else if error}
  <PageHeader title="User" subtitle="Error loading user" />
  <Card><div class="text-sm text-danger">{error}</div></Card>
{:else if user}
  <PageHeader title={user.username} subtitle="User details">
    {#snippet actions()}
      <button type="button" onclick={impersonate}
        class="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text hover:border-primary/40">
        Impersonate
      </button>
      <button type="button" onclick={deleteUser}
        class="rounded-md border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20">
        Delete User
      </button>
    {/snippet}
  </PageHeader>

  {#if saveMsg}
    <Card class="mb-4">
      <div class="text-sm {saveMsg === 'User updated successfully' ? 'text-success' : 'text-danger'}">{saveMsg}</div>
    </Card>
  {/if}

  <!-- Edit User -->
  <Card title="Edit User" subtitle="Update email and roles">
    <form onsubmit={saveUser} class="space-y-3">
      <div>
        <label for="editUsername" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Username</label>
        <input id="editUsername" type="text" value={user.username} disabled
          class="w-full rounded-md border border-border bg-surface/50 px-3 py-2 text-sm text-muted" />
      </div>
      <div>
        <label for="editEmail" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Email</label>
        <input id="editEmail" type="email" bind:value={editEmail} required
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none" />
      </div>
      <div>
        <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Roles</span>
        <FilterHorizontal
          id="editRoles"
          label="roles"
          options={roleOptions}
          bind:selected={editRoles}
          locked={lockedRoles}
          disabled={saving}
          helpText={isSelf ? 'You cannot remove admin from your own account.' : 'Hold Ctrl/⌘ to pick several, or double-click to move one. An account with no roles is saved as "user".'}
        />
        {#if rolesDirty}
          <div class="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted">
            <span>Saved:</span>
            {#each user.roles as role}
              <StatusBadge label={role} tone={role === 'admin' ? 'primary' : 'muted'} size="sm" />
            {/each}
            <span class="ml-1">→ unsaved changes</span>
          </div>
        {/if}
      </div>
      <button type="submit" disabled={saving}
        class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
        {saving ? 'Saving…' : 'Save Changes'}
      </button>
    </form>
  </Card>

  <!-- Networks & Channels -->
  {#if user.networks?.length}
    <Card class="mt-6" title="Networks & Channels" subtitle={`${user.networks.length} networks`}>
      <div class="space-y-3">
        {#each user.networks as net (net.id)}
          <div class="rounded-md border {net.connected ? 'border-l-success border-l-3 border-border' : 'border-l-muted border-l-3 border-border'} overflow-hidden">
            <div class="flex flex-wrap items-center gap-2 bg-surface/50 px-4 py-2">
              <span class="h-2 w-2 rounded-full {net.connected ? 'bg-success' : 'bg-muted'}"></span>
              <span class="font-semibold text-heading">{net.name}</span>
              <span class="font-mono text-xs text-muted">{net.host}:{net.port}</span>
              <div class="ml-auto flex items-center gap-2">
                <StatusBadge label={net.connected ? 'connected' : net.disabled ? 'disabled' : 'offline'} tone={net.connected ? 'success' : net.disabled ? 'danger' : 'muted'} size="sm" />
                {#if net.currentNick}
                  <span class="text-xs text-muted">nick: {net.currentNick}</span>
                {/if}
                {#if net.connected}
                  <button
                    type="button"
                    onclick={() => disconnectNetwork(net)}
                    disabled={disconnecting.has(net.id)}
                    class="rounded border border-danger/30 px-2 py-0.5 text-[10px] font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    {disconnecting.has(net.id) ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                {/if}
              </div>
            </div>
            {#if net.autoJoinChannels?.length}
              <div class="border-t border-border/40 px-4 py-1.5 text-xs text-muted">
                {net.autoJoinChannels.length} auto-join channel{net.autoJoinChannels.length === 1 ? '' : 's'}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </Card>
  {/if}

  <!-- Uploads -->
  {#if user.uploads?.length}
    <Card class="mt-6" title="Uploads" subtitle={`${user.uploads.length} files`}>
      <div class="space-y-2">
        {#each user.uploads as upload (upload.id)}
          <div class="flex items-center gap-3 border-b border-border/30 py-2 last:border-b-0">
            {#if upload.directUrl && isImage(upload.mimeType)}
              <img src={upload.directUrl} alt={upload.filename}
                class="h-12 w-12 shrink-0 rounded border border-border object-cover" />
            {:else}
              <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-border text-lg text-muted">📎</div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium text-text">{upload.filename}</div>
              <div class="text-xs text-muted">{upload.mimeType} · {fmtSize(upload.size)}</div>
              {#if upload.buffer}
                <div class="text-xs text-muted">#{upload.buffer}</div>
              {/if}
            </div>
            {#if upload.directUrl}
              <a href={upload.directUrl} target="_blank"
                class="shrink-0 rounded border border-border bg-surface px-2 py-1 text-xs text-text hover:border-primary/40">
                View
              </a>
            {/if}
          </div>
        {/each}
      </div>
    </Card>
  {/if}

  <!-- IP Addresses -->
  <Card class="mt-6" title="IP Addresses" subtitle="Signup and login history">
    <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <dt class="text-xs font-semibold uppercase tracking-wider text-muted">Signup IP</dt>
        <dd class="font-mono text-sm text-text">{user.signupIp || '—'}</dd>
      </div>
      <div>
        <dt class="text-xs font-semibold uppercase tracking-wider text-muted">Signup Date</dt>
        <dd class="text-sm text-text">{user.createdAt > 0 ? new Date(user.createdAt * 1000).toLocaleString() : '—'}</dd>
      </div>
      <div>
        <dt class="text-xs font-semibold uppercase tracking-wider text-muted">Last Login IP</dt>
        <dd class="font-mono text-sm text-text">{user.lastLoginIp || '—'}</dd>
      </div>
      <div>
        <dt class="text-xs font-semibold uppercase tracking-wider text-muted">All Login IPs</dt>
        <dd>
          {#if user.loginIps?.length}
            <div class="space-y-0.5">
              {#each user.loginIps as ip}
                <div class="font-mono text-sm text-text">{ip}</div>
              {/each}
            </div>
          {:else}
            <span class="text-sm text-muted">—</span>
          {/if}
        </dd>
      </div>
    </dl>
  </Card>

  <!-- Reset Password -->
  <Card class="mt-6" title="Reset Password" subtitle="Set a new password for this user">
    {#if resetMsg}
      <div class="mb-3 text-sm {resetMsg === 'Password reset successfully' ? 'text-success' : 'text-danger'}">{resetMsg}</div>
    {/if}
    <form onsubmit={resetPassword} class="flex items-end gap-3">
      <div class="flex-1">
        <label for="newPass" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">New Password</label>
        <input id="newPass" type="password" bind:value={newPass} placeholder="Leave blank for 'changeme123'"
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none" />
      </div>
      <button type="submit" disabled={resetting}
        class="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
        {resetting ? 'Resetting…' : 'Reset'}
      </button>
    </form>
  </Card>
{/if}