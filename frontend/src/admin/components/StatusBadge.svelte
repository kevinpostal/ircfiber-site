<script lang="ts">
  /**
   * StatusBadge — colored pill with optional dot + label.
   * `tone` controls color; pass any of: success, warn, danger, info, muted, primary.
   */
  interface Props {
    label: string;
    tone?: 'success' | 'warn' | 'danger' | 'info' | 'muted' | 'primary';
    dot?: boolean;
    size?: 'sm' | 'md';
  }
  let { label, tone = 'muted', dot = true, size = 'md' }: Props = $props();

  const tones: Record<string, { bg: string; fg: string; dot: string }> = {
    success: { bg: 'bg-success/10', fg: 'text-success', dot: 'bg-success' },
    warn: { bg: 'bg-warn/10', fg: 'text-warn', dot: 'bg-warn' },
    danger: { bg: 'bg-danger/10', fg: 'text-danger', dot: 'bg-danger' },
    info: { bg: 'bg-info/10', fg: 'text-info', dot: 'bg-info' },
    muted: { bg: 'bg-border', fg: 'text-muted', dot: 'bg-muted' },
    primary: { bg: 'bg-primary/10', fg: 'text-primary', dot: 'bg-primary' },
  };
  const t = $derived(tones[tone] ?? tones.muted);
</script>

<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 font-semibold {t.bg} {t.fg} {size === 'sm' ? 'py-0.5 text-[10px]' : 'py-1 text-xs'}">
  {#if dot}
    <span class="h-1.5 w-1.5 rounded-full {t.dot}"></span>
  {/if}
  {label}
</span>