<script lang="ts">
  /**
   * FiberEyeRulesCard — the ban rules, editable.
   *
   * FiberEye's thresholds used to be frozen env vars: changing one meant a
   * commit plus `ansible-playbook … -t fibereye`. This card writes an
   * override to Mongo, which is mirrored to Redis and picked up by the
   * running bot within one sideband tick (≤5 s) — no redeploy.
   *
   * The deployed env baseline is always shown alongside, and Reset drops
   * the override so the deploy's values take over again.
   */
  import { onMount, onDestroy } from 'svelte';
  import Card from './Card.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import EmptyState from './EmptyState.svelte';
  import StringListEditor from './StringListEditor.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { relative } from '../lib/format';

  export interface RuleSet {
    windowSeconds: number;
    connects: number; connectsEnabled: boolean;
    nicks: number; nicksEnabled: boolean;
    churn: number; churnEnabled: boolean;
    shortMs: number; banSeconds: number;
    ignoreClasses: string[]; exemptIps: string[]; exemptNicks: string[];
    updatedAtMs: number; updatedBy: string;
  }
  interface Bounds {
    windowMin: number; windowMax: number;
    countMin: number; countMax: number;
    shortMsMin: number; shortMsMax: number;
    banSecondsMin: number; banSecondsMax: number;
    listMax: number;
  }
  interface AuditRow { id: string; atMs: number; actor: string; action: string; summary: string }
  interface RulesPayload {
    effective: RuleSet | null;
    deployed: RuleSet | null;
    stored: RuleSet | null;
    source: 'override' | 'deployed' | 'unknown';
    bounds: Bounds;
    audit: AuditRow[];
  }

  interface Props { intervalMs?: number }
  let { intervalMs = 5_000 }: Props = $props();

  const FALLBACK_BOUNDS: Bounds = {
    windowMin: 5, windowMax: 3_600, countMin: 2, countMax: 100_000,
    shortMsMin: 1_000, shortMsMax: 600_000,
    banSecondsMin: 60, banSecondsMax: 2_592_000, listMax: 64,
  };

  let data = $state<RulesPayload | null>(null);
  let loadError = $state<string | null>(null);
  let saveErrors = $state<string[]>([]);
  let dirty = $state(false);
  let saving = $state(false);
  let askReset = $state(false);

  // Form mirrors, seeded by load() from whatever is in force.
  let windowSeconds = $state(60);
  let connects = $state(10);
  let connectsEnabled = $state(true);
  let nicks = $state(6);
  let nicksEnabled = $state(true);
  let churn = $state(6);
  let churnEnabled = $state(true);
  let shortSeconds = $state(20);
  let banSeconds = $state(3_600);
  let ignoreClasses = $state<string[]>([]);
  let exemptIps = $state<string[]>([]);
  let exemptNicks = $state<string[]>([]);

  const bounds = $derived(data?.bounds ?? FALLBACK_BOUNDS);
  const source = $derived(data?.source ?? 'unknown');
  const badge = $derived(
    source === 'override'
      ? { label: 'Custom rules', tone: 'info' as const }
      : source === 'deployed'
      ? { label: 'Deployed defaults', tone: 'muted' as const }
      : { label: 'No heartbeat', tone: 'warn' as const },
  );

  /**
   * Whether the bot is enforcing what is stored. `effective` is the
   * heartbeat's own rule set, so this is the proof a save actually reached
   * the running bot rather than just the database.
   */
  const pickup = $derived.by(() => {
    if (!data) return null;
    const storedAt = data.stored?.updatedAtMs ?? 0;
    const liveAt = data.effective?.updatedAtMs ?? 0;
    if (!data.effective) return { label: 'Bot offline — rules stored, not yet in force', tone: 'warn' as const };
    if (storedAt === liveAt) return { label: 'In force', tone: 'success' as const };
    return { label: 'Pending — the bot picks up changes within 5s', tone: 'warn' as const };
  });

  function seed(r: RuleSet) {
    windowSeconds = r.windowSeconds;
    connects = r.connects;
    connectsEnabled = r.connectsEnabled;
    nicks = r.nicks;
    nicksEnabled = r.nicksEnabled;
    churn = r.churn;
    churnEnabled = r.churnEnabled;
    shortSeconds = Math.round(r.shortMs / 1000);
    banSeconds = r.banSeconds;
    ignoreClasses = [...r.ignoreClasses];
    exemptIps = [...r.exemptIps];
    exemptNicks = [...(r.exemptNicks ?? [])];
    dirty = false;
  }

  function load(p: RulesPayload) {
    data = p;
    const base = p.stored ?? p.effective ?? p.deployed;
    if (base) seed(base);
  }

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function fetchRules() {
    try {
      const next = await api.get<RulesPayload>('/api/admin/fibereye/rules');
      // A poll must never overwrite half-typed changes; only the read-only
      // parts (source, audit, what the bot reports) refresh while dirty.
      if (dirty) data = next;
      else load(next);
      loadError = null;
    } catch (e) {
      loadError = errMsg(e);
    }
  }

  let stop: (() => void) | null = null;
  onMount(() => { stop = startPolling(fetchRules, { intervalMs }); });
  onDestroy(() => stop?.());

  function body(): RuleSet {
    return {
      windowSeconds: Number(windowSeconds),
      connects: Number(connects), connectsEnabled,
      nicks: Number(nicks), nicksEnabled,
      churn: Number(churn), churnEnabled,
      shortMs: Math.round(Number(shortSeconds) * 1000),
      banSeconds: Number(banSeconds),
      ignoreClasses: [...ignoreClasses],
      exemptIps: [...exemptIps],
      exemptNicks: [...exemptNicks],
      updatedAtMs: 0, updatedBy: '',
    };
  }

  async function save() {
    if (saving) return;
    saving = true;
    saveErrors = [];
    try {
      load(await api.post<RulesPayload>('/api/admin/fibereye/rules', body()));
      toastSuccess('Ban rules saved — the bot picks them up within 5s');
    } catch (e) {
      // A refused save keeps the form dirty and shows every reason, so the
      // admin fixes all of them in one pass.
      saveErrors = e instanceof ApiError && e.errors.length ? e.errors : [errMsg(e)];
      toastError(errMsg(e));
    } finally {
      saving = false;
    }
  }

  async function reset() {
    askReset = false;
    saving = true;
    saveErrors = [];
    try {
      load(await api.post<RulesPayload>('/api/admin/fibereye/rules/reset'));
      toastSuccess('Restored the deployed ban rules');
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      saving = false;
    }
  }

  function touch() { dirty = true; }

  // ── client-side mirrors of the server's validators (instant feedback;
  //    the server stays authoritative) ────────────────────────────────
  function isIpv4(s: string): boolean {
    const parts = s.split('.');
    if (parts.length !== 4) return false;
    return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  }
  function isIpv6(s: string): boolean {
    if (!s.includes(':')) return false;
    if (!/^[0-9a-fA-F:]+$/.test(s)) return false;
    if (s.split('::').length > 2) return false;
    return s.split(':').filter((g) => g !== '').length <= 8;
  }
  function validExempt(v: string): string | null {
    if (v.length > 128) return 'Too long for an address.';
    if (/[\s,*?]/.test(v)) return 'No globs, spaces or commas — an exempt address can never be banned.';
    const slash = v.lastIndexOf('/');
    const net = slash < 0 ? v : v.slice(0, slash);
    const v6 = net.includes(':');
    if (v6 ? !isIpv6(net) : !isIpv4(net)) return 'Not an IP address.';
    if (slash < 0) return null;
    const bits = Number(v.slice(slash + 1));
    if (!Number.isInteger(bits)) return 'The prefix must be a whole number.';
    if (v6 && (bits < 32 || bits > 128)) return 'A v6 exemption may not be wider than /32.';
    if (!v6 && (bits < 16 || bits > 32)) return 'A v4 exemption may not be wider than /16.';
    return null;
  }
  // Mirrors validExemptNick() on the server (instant feedback; the server
  // stays authoritative).
  function validNickExempt(v: string): string | null {
    if (!v.length || v.length > 32) return 'A nick is 1–32 characters.';
    if (/[\s,!@.#&:]/.test(v)) return 'No spaces, commas or !@.#&: — a nick exemption is a nick, optionally with * or ?.';
    const literal = v.replace(/[*?]/g, '');
    if (literal.length < 2) return 'Needs at least two non-wildcard characters — a bare * would exempt everyone.';
    if (!/^[A-Za-z[\]\\`_^{|}*?]/.test(v)) return 'Must start with a letter, a nick symbol ([]{}`_^{|}) or a wildcard.';
    if (!/^[A-Za-z0-9[\]\\`_^{|}\-*?]+$/.test(v)) return 'Not an IRC nick — letters, digits, []{}`_^{|}- plus * or ?.';
    return null;
  }
  function validClass(v: string): string | null {
    if (v.length > 64) return 'Too long for a connect class.';
    if (/[\s,]/.test(v)) return 'A connect class carries no spaces or commas.';
    return null;
  }

  function duration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
    const hours = seconds / 3_600;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  // Mirrors banDurationFor(): 1× / 24× / 168×.
  const escalation = $derived(
    `1st strike ${duration(banSeconds)} · 2nd ${duration(banSeconds * 24)} · 3rd+ ${duration(banSeconds * 168)}`,
  );

  const deployedSummary = $derived.by(() => {
    const d = data?.deployed;
    if (!d) return 'the values this deployment shipped with';
    return `window ${d.windowSeconds}s, ${d.connects} connects, ${d.nicks} nicks, `
      + `${d.churn} short sessions, first ban ${d.banSeconds}s`;
  });

  function actionLabel(a: string): string {
    if (a === 'rules_update') return 'changed the rules';
    if (a === 'rules_reset') return 'reset to deployed';
    if (a === 'arm') return 'armed enforcement';
    if (a === 'disarm') return 'disarmed enforcement';
    return a;
  }
</script>

<Card title="Ban rules" subtitle="What FiberEye counts as an attack. Saved changes reach the running bot within 5 seconds.">
  {#snippet actions()}
    <StatusBadge label={badge.label} tone={badge.tone} />
    {#if pickup}
      <StatusBadge label={pickup.label} tone={pickup.tone} size="sm" dot={false} />
    {/if}
  {/snippet}

  {#if loadError}
    <p class="mb-3 text-sm text-danger">{loadError}</p>
  {/if}

  <div class="grid gap-5 md:grid-cols-2">
    <div class="space-y-4">
      <label class="flex items-center justify-between gap-3 text-sm">
        <span>
          <span class="font-medium text-heading">Counting window</span>
          <span class="block text-[11px] text-muted">Every count below is per address group, inside this window.</span>
        </span>
        <span class="flex shrink-0 items-center gap-1">
          <input type="number" bind:value={windowSeconds} oninput={touch}
            min={bounds.windowMin} max={bounds.windowMax}
            class="w-24 rounded-md border border-border bg-surface px-2 py-1 text-right font-mono text-xs text-text" />
          <span class="text-xs text-muted">s</span>
        </span>
      </label>

      <div class="space-y-3 border-t border-border pt-3">
        <label class="flex items-center justify-between gap-3 text-sm">
          <span class="flex items-center gap-2">
            <input type="checkbox" bind:checked={connectsEnabled} onchange={touch} />
            <span>
              <span class="font-medium text-heading">Connect flood</span>
              <span class="block text-[11px] text-muted">Connects from one address group per window.</span>
            </span>
          </span>
          <input type="number" bind:value={connects} oninput={touch} disabled={!connectsEnabled}
            min={bounds.countMin} max={bounds.countMax}
            class="w-24 shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-right font-mono text-xs text-text disabled:opacity-40" />
        </label>

        <label class="flex items-center justify-between gap-3 text-sm">
          <span class="flex items-center gap-2">
            <input type="checkbox" bind:checked={nicksEnabled} onchange={touch} />
            <span>
              <span class="font-medium text-heading">Nick churn</span>
              <span class="block text-[11px] text-muted">Distinct nicknames from one address group per window.</span>
            </span>
          </span>
          <input type="number" bind:value={nicks} oninput={touch} disabled={!nicksEnabled}
            min={bounds.countMin} max={bounds.countMax}
            class="w-24 shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-right font-mono text-xs text-text disabled:opacity-40" />
        </label>

        <label class="flex items-center justify-between gap-3 text-sm">
          <span class="flex items-center gap-2">
            <input type="checkbox" bind:checked={churnEnabled} onchange={touch} />
            <span>
              <span class="font-medium text-heading">Session churn</span>
              <span class="block text-[11px] text-muted">Short sessions from one address group per window.</span>
            </span>
          </span>
          <input type="number" bind:value={churn} oninput={touch} disabled={!churnEnabled}
            min={bounds.countMin} max={bounds.countMax}
            class="w-24 shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-right font-mono text-xs text-text disabled:opacity-40" />
        </label>

        <label class="flex items-center justify-between gap-3 pl-6 text-sm">
          <span class="text-[11px] text-muted">counts sessions shorter than</span>
          <span class="flex shrink-0 items-center gap-1">
            <input type="number" bind:value={shortSeconds} oninput={touch} disabled={!churnEnabled}
              min={Math.round(bounds.shortMsMin / 1000)} max={Math.round(bounds.shortMsMax / 1000)}
              class="w-24 rounded-md border border-border bg-surface px-2 py-1 text-right font-mono text-xs text-text disabled:opacity-40" />
            <span class="text-xs text-muted">s</span>
          </span>
        </label>
      </div>

      <label class="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
        <span>
          <span class="font-medium text-heading">First ban</span>
          <span class="block text-[11px] text-muted">{escalation}</span>
        </span>
        <span class="flex shrink-0 items-center gap-1">
          <input type="number" bind:value={banSeconds} oninput={touch}
            min={bounds.banSecondsMin} max={bounds.banSecondsMax}
            class="w-24 rounded-md border border-border bg-surface px-2 py-1 text-right font-mono text-xs text-text" />
          <span class="text-xs text-muted">s</span>
        </span>
      </label>
    </div>

    <div class="space-y-4">
      <StringListEditor
        label="Ignored connect classes"
        bind:entries={ignoreClasses}
        placeholder="ircfiber-engine"
        helpText="Connects in these ircd connect classes are never counted and never banned."
        validate={validClass}
        onchange={touch}
        inputId="fibereye-ignore-class"
      />
      <StringListEditor
        label="Exempt addresses"
        bind:entries={exemptIps}
        placeholder="203.0.113.7 or 2001:db8::/64"
        helpText="Never counted, never banned. An address or CIDR — no globs, and no wider than /16 (v4) or /32 (v6)."
        validate={validExempt}
        onchange={touch}
        inputId="fibereye-exempt-ip"
      />
      <StringListEditor
        label="Exempt nicks"
        bind:entries={exemptNicks}
        placeholder="p34c3*"
        helpText="Never counted, never banned — only their own connects are skipped, so strangers on the same exit are still caught. An exact nick or a * / ? glob, case-insensitive. FiberEye only: the ircd's own connectban still applies."
        validate={validNickExempt}
        onchange={touch}
        inputId="fibereye-exempt-nick"
      />
    </div>
  </div>

  {#if saveErrors.length}
    <ul class="mt-4 space-y-1 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
      {#each saveErrors as e (e)}<li>{e}</li>{/each}
    </ul>
  {/if}

  <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
    <button type="button" onclick={() => void save()} disabled={saving || !dirty}
      class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
      {saving ? 'Saving…' : 'Save rules'}
    </button>
    <button type="button" onclick={() => (askReset = true)} disabled={saving || source !== 'override'}
      class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-border disabled:opacity-50">
      Reset to deployed
    </button>
    <span class="text-xs text-muted">
      {#if data?.stored}
        Last changed by {data.stored.updatedBy || 'unknown'} {relative(data.stored.updatedAtMs)}.
      {:else}
        No override stored; the deployed values are in force.
      {/if}
    </span>
  </div>

  <div class="mt-4 border-t border-border pt-3">
    <h3 class="text-xs font-semibold text-heading">Recent changes</h3>
    {#if data?.audit?.length}
      <ul class="mt-2 space-y-1 text-xs">
        {#each data.audit as row (row.id)}
          <li class="flex flex-wrap gap-x-2 text-muted">
            <span class="font-mono">{relative(row.atMs)}</span>
            <span class="text-text">{row.actor || 'system'}</span>
            <span>{actionLabel(row.action)}</span>
            {#if row.summary}<span class="font-mono">— {row.summary}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <EmptyState title="No rule changes yet" description="Saves, resets and arming are recorded here." icon="🕗" />
    {/if}
  </div>
</Card>

<ConfirmDialog
  open={askReset}
  title="Reset the ban rules?"
  message={`FiberEye goes back to ${deployedSummary}. The stored override is deleted and the bot reloads within 5 seconds.`}
  confirmLabel="Reset to deployed"
  tone="warn"
  onConfirm={reset}
  onCancel={() => (askReset = false)}
/>
