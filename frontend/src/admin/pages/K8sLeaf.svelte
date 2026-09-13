<script lang="ts">
  /**
   * K8s leaf page — turn the k3s InspIRCd leaf (k8s.ircfiber.com) on and off,
   * and prove the cluster and hub sides are healthy before starting it.
   *
   * The leaf's Deployment replica count is the single source of truth for
   * "on". The hub declares the `<link>` but never dials it: its old
   * `<autoconnect period="16s">` turned an evicted pod into a network-wide
   * REMOTELINK snotice storm on every peer. Start issues the CONNECT, Stop
   * SQUITs before scaling to 0, and the gateway reconciles once a minute.
   *
   * Backed by /api/admin/ircd/leaf{,/preflight,/start,/stop}
   * (site/backend/source/ircfiber/web/admin/leaf.d).
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import RefreshIndicator from '../components/RefreshIndicator.svelte';
  import { ApiError } from '../lib/api-client';
  import { relative } from '../lib/format';
  import { startPolling } from '../stores/polling';
  import { toastSuccess, toastError } from '../stores/ui';
  import {
    leaf, leafLoading, leafError,
    fetchLeaf, runPreflight, startLeaf, stopLeaf,
    type CheckStatus, type LeafCheck, type LeafState,
  } from '../stores/k8sLeaf';

  let lastFetchedAt = $state<number | null>(null);
  let stop: (() => void) | null = null;

  let checks = $state<LeafCheck[] | null>(null);
  let preflightOk = $state(false);
  let preflightRunning = $state(false);
  let preflightError = $state<string | null>(null);

  let force = $state(false);
  let ask = $state<'start' | 'stop' | null>(null);
  let acting = $state(false);
  let stopReason = $state('Leaf stopped from the admin dashboard');
  let logTail = $state<string[] | null>(null);

  onMount(() => {
    stop = startPolling(async () => {
      await fetchLeaf(true);
      lastFetchedAt = Date.now();
    });
    void preflight();
  });
  onDestroy(() => stop?.());

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function preflight() {
    preflightRunning = true;
    preflightError = null;
    try {
      const r = await runPreflight();
      checks = r.checks;
      preflightOk = r.ok;
    } catch (e) {
      checks = null;
      preflightOk = false;
      preflightError = errMsg(e);
    } finally {
      preflightRunning = false;
    }
  }

  const stateTone: Record<LeafState, 'success' | 'warn' | 'danger' | 'muted'> = {
    on: 'success',
    starting: 'warn',
    off: 'muted',
    degraded: 'danger',
  };
  const checkTone: Record<CheckStatus, 'success' | 'warn' | 'danger'> = {
    pass: 'success',
    warn: 'warn',
    fail: 'danger',
  };

  const nodePressure = $derived(
    !!$leaf && ($leaf.node.diskPressure || $leaf.node.memoryPressure || $leaf.node.pidPressure),
  );
  /** A failed check blocks Start unless the operator overrides it. */
  const startBlocked = $derived(checks !== null && !preflightOk && !force);

  /** The modal closes whatever the outcome: a 504 leaves the Deployment at
   *  1 replica, and the operator has to see that state (and the log tail)
   *  to decide between waiting and pressing Stop. */
  async function doStart() {
    acting = true;
    logTail = null;
    try {
      const r = await startLeaf(force);
      if (r.linked) toastSuccess(`${$leaf?.name ?? 'Leaf'} linked in ${Math.round(r.elapsedMs / 1000)}s`);
      else {
        toastError(`Pod is ready but the link did not come up: ${r.notice || 'no notice'}`);
        logTail = r.podLogTail ?? null;
      }
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      ask = null;
      acting = false;
      await fetchLeaf(true);
      lastFetchedAt = Date.now();
      await preflight();
    }
  }

  async function doStop() {
    acting = true;
    logTail = null;
    try {
      const s = await stopLeaf(stopReason);
      leaf.set(s);
      toastSuccess(`${s.name} unlinked and scaled to 0`);
    } catch (e) {
      toastError(errMsg(e));
      await fetchLeaf(true);
    } finally {
      ask = null;
      acting = false;
      lastFetchedAt = Date.now();
      await preflight();
    }
  }
</script>

<PageHeader
  title="K8s leaf"
  subtitle="The k3s InspIRCd leaf on ubuntu-docker — replicas are the source of truth; the hub never dials it"
>
  {#snippet actions()}
    {#if $leaf}
      <StatusBadge label={$leaf.state} tone={stateTone[$leaf.state]} />
    {/if}
    <RefreshIndicator {lastFetchedAt} loading={$leafLoading} />
  {/snippet}
</PageHeader>

{#if $leafError}
  <Card class="mb-6">
    <p class="text-sm text-danger">{$leafError}</p>
  </Card>
{/if}

{#if $leaf && !$leaf.k8sConfigured}
  <Card class="mb-6">
    <p class="text-sm text-warn">
      This gateway has no k3s credentials (IRCFIBER_K8S_TOKEN), so the leaf cannot be
      scaled from here. Deploy roles/gateway; the IRC-side fields below are still live.
    </p>
  </Card>
{:else if $leaf && $leaf.k8sError}
  <Card class="mb-6">
    <p class="text-sm text-danger">k3s API: {$leaf.k8sError}</p>
  </Card>
{/if}

<Card
  title="Preflight"
  subtitle="Run before Start: cluster reachability, node health, workload, hub declaration, network path"
  class="mb-6"
>
  {#snippet actions()}
    <button
      type="button"
      class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-text hover:border-primary/40 disabled:opacity-50"
      onclick={preflight}
      disabled={preflightRunning}
    >{preflightRunning ? 'Checking…' : 'Run preflight'}</button>
  {/snippet}

  {#if preflightError}
    <p class="text-sm text-danger">{preflightError}</p>
  {:else if checks === null}
    <p class="text-sm text-muted">{preflightRunning ? 'Running checks…' : 'No checks run yet.'}</p>
  {:else}
    <ul class="divide-y divide-border/50" data-testid="preflight-checks">
      {#each checks as c (c.id)}
        <li class="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
          <span class="mt-0.5 shrink-0">
            <StatusBadge label={c.status} tone={checkTone[c.status]} size="sm" />
          </span>
          <div class="min-w-0">
            <p class="text-sm font-medium text-text">{c.label}</p>
            <p class="mt-0.5 text-xs text-muted">{c.detail}</p>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</Card>

<Card title="Control" subtitle="Start = scale to 1 + CONNECT · Stop = SQUIT + scale to 0" class="mb-6">
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
      disabled={acting || startBlocked || $leaf?.state === 'on'}
      title={startBlocked
        ? 'A preflight check failed — fix it or tick the override'
        : $leaf?.state === 'on'
        ? 'The leaf is already linked'
        : 'Scale the Deployment to 1, wait for a ready pod, then CONNECT'}
      onclick={() => (ask = 'start')}
    >{acting && ask === 'start' ? 'Starting…' : 'Start leaf'}</button>

    <button
      type="button"
      class="rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:bg-danger/90 disabled:opacity-50"
      disabled={acting || $leaf?.state === 'off'}
      title="SQUIT the leaf off the network, then scale the Deployment to 0"
      onclick={() => (ask = 'stop')}
    >{acting && ask === 'stop' ? 'Stopping…' : 'Stop leaf'}</button>

    <label class="flex items-center gap-2 text-xs text-muted">
      <input type="checkbox" bind:checked={force} class="rounded border-border bg-surface-2" />
      Start anyway (override failed checks)
    </label>
  </div>

  {#if startBlocked}
    <p class="mt-3 text-xs text-danger">
      Start is disabled: {checks?.filter((c) => c.status === 'fail').map((c) => c.id).join(', ')}
      failed. DiskPressure is the usual one — the kubelet evicts the pod as fast as it is created.
    </p>
  {/if}

  <div class="mt-4">
    <label for="stop-reason" class="block text-xs text-muted mb-1">SQUIT reason (shown to every peer)</label>
    <input
      id="stop-reason"
      type="text"
      bind:value={stopReason}
      maxlength="120"
      class="w-full max-w-lg rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm"
    />
  </div>

  {#if logTail && logTail.length > 0}
    <div class="mt-4">
      <p class="mb-1 text-xs text-muted">Leaf pod log tail (the link failure reason is in here):</p>
      <pre
        class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 font-mono text-xs text-text"
        data-testid="leaf-log-tail"
      >{logTail.join('\n')}</pre>
    </div>
  {/if}
</Card>

<Card title="Kubernetes" subtitle="Deployment, pod, node and the hub's <link> declaration">
  {#if !$leaf}
    <p class="text-sm text-muted">Loading…</p>
  {:else}
    <dl class="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
      <div>
        <dt class="text-xs text-muted">Deployment</dt>
        <dd class="font-mono text-text">
          {$leaf.deployment.exists
            ? `${$leaf.deployment.ready}/${$leaf.deployment.desired} ready`
            : 'missing'}
          {#if $leaf.deployment.available}
            <span class="text-muted">· Available={$leaf.deployment.available}</span>
          {/if}
        </dd>
        {#if $leaf.deployment.message}
          <dd class="mt-0.5 text-xs text-muted">{$leaf.deployment.message}</dd>
        {/if}
      </div>
      <div>
        <dt class="text-xs text-muted">Image</dt>
        <dd class="break-all font-mono text-xs text-text">{$leaf.deployment.image || '—'}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted">Pod</dt>
        <dd class="break-all font-mono text-xs text-text">{$leaf.pod.name || '—'}</dd>
        <dd class="mt-0.5 text-xs text-muted">
          {$leaf.pod.phase || 'no pod'}
          {$leaf.pod.ready ? '· ready' : ''}
          · {$leaf.pod.restarts} restart{$leaf.pod.restarts === 1 ? '' : 's'}
          {#if $leaf.pod.startedAtMs > 0}· started {relative($leaf.pod.startedAtMs)}{/if}
        </dd>
        {#if $leaf.pod.message}
          <dd class="mt-0.5 text-xs text-danger">{$leaf.pod.message}</dd>
        {/if}
      </div>
      <div>
        <dt class="text-xs text-muted">Node</dt>
        <dd class="flex flex-wrap items-center gap-1.5">
          <StatusBadge
            label={$leaf.node.found ? ($leaf.node.ready ? 'Ready' : 'NotReady') : 'not found'}
            tone={$leaf.node.found && $leaf.node.ready ? 'success' : 'danger'}
            size="sm"
          />
          {#if $leaf.node.diskPressure}<StatusBadge label="DiskPressure" tone="danger" size="sm" />{/if}
          {#if $leaf.node.memoryPressure}<StatusBadge label="MemoryPressure" tone="danger" size="sm" />{/if}
          {#if $leaf.node.pidPressure}<StatusBadge label="PIDPressure" tone="danger" size="sm" />{/if}
          {#if $leaf.node.unschedulable}<StatusBadge label="cordoned" tone="warn" size="sm" />{/if}
          {#if $leaf.node.diskPressureTaint && !nodePressure}
            <StatusBadge label="disk-pressure taint" tone="warn" size="sm" />
          {/if}
        </dd>
      </div>
      <div>
        <dt class="text-xs text-muted">Hub &lt;link&gt;</dt>
        <dd class="font-mono text-xs text-text">
          {$leaf.link.present
            ? `${$leaf.link.ipaddr || '?'}:${$leaf.link.port || '?'}`
            : 'not declared'}
        </dd>
        <dd class="mt-0.5 text-xs {$leaf.link.autoconnect ? 'text-warn' : 'text-muted'}">
          {$leaf.link.autoconnect
            ? 'autoconnect still set — remove it, two dialers race'
            : 'no autoconnect (this page is the only dialer)'}
        </dd>
      </div>
      <div>
        <dt class="text-xs text-muted">Linked now</dt>
        <dd>
          <StatusBadge
            label={$leaf.linked ? 'on the network' : 'not linked'}
            tone={$leaf.linked ? 'success' : 'muted'}
            size="sm"
          />
        </dd>
      </div>
    </dl>
  {/if}
</Card>

<ConfirmDialog
  open={ask === 'start'}
  title="Start {$leaf?.name ?? 'the leaf'}?"
  message={`Scale ${$leaf?.deployment.exists ? 'the Deployment' : 'the (missing) Deployment'} to 1, wait up to 120s for a ready pod, then CONNECT from the hub.${force ? ' Failed preflight checks are being overridden.' : ''}`}
  confirmLabel="Start"
  tone="primary"
  onConfirm={doStart}
  onCancel={() => (ask = null)}
/>

<ConfirmDialog
  open={ask === 'stop'}
  title="Stop {$leaf?.name ?? 'the leaf'}?"
  message={`SQUIT ${$leaf?.name ?? 'the leaf'} off the live network and scale the Deployment to 0. Every peer sees the netsplit. Type the server name to confirm.`}
  confirmLabel="Stop"
  tone="danger"
  requireText={$leaf?.name}
  onConfirm={doStop}
  onCancel={() => (ask = null)}
/>
