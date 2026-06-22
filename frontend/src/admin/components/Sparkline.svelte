<script lang="ts">
  /**
   * Sparkline — tiny inline SVG line chart, no dependencies.
   * Renders a series of numbers as a 100%-wide path.
   * Use for: memory time-series, ops/sec, etc.
   */
  interface Props {
    values: number[];
    width?: number;
    height?: number;
    stroke?: string;
    fill?: string;
    strokeWidth?: number;
  }
  let {
    values,
    width = 120,
    height = 32,
    stroke = 'currentColor',
    fill = 'transparent',
    strokeWidth = 1.5,
  }: Props = $props();

  const path = $derived.by(() => {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const stepX = width / (values.length - 1);
    return values
      .map((v, i) => {
        const x = i * stepX;
        const y = height - ((v - min) / range) * height;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  });

  const areaPath = $derived.by(() => {
    if (!path) return '';
    return `${path} L ${width} ${height} L 0 ${height} Z`;
  });
</script>

<svg viewBox="0 0 {width} {height}" preserveAspectRatio="none" class="overflow-visible">
  {#if fill !== 'transparent'}
    <path d={areaPath} fill={fill} />
  {/if}
  <path d={path} fill="none" stroke={stroke} stroke-width={strokeWidth} stroke-linejoin="round" stroke-linecap="round" />
</svg>