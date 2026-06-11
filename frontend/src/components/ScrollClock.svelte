<script lang="ts">
  import { formatDateTimeTitle } from '../lib/utils';

  interface Props {
    /** Timestamp of the message at the top of the scroll, or null when
     *  the clock is hidden (at bottom / no upper message). */
    ts: number | null;
  }
  let { ts }: Props = $props();

  // ── IRCCloud ScrollClockView geometry (radius 7, offset 1 → 16px) ──
  const RADIUS = 7;
  const OFFSET = 1;
  const DIAMETER = (RADIUS + OFFSET) * 2;

  let canvas = $state<HTMLCanvasElement | null>(null);
  let now = $state(Date.now());

  const date = $derived(ts !== null ? new Date(ts) : null);

  // jQuery timeago auto-refresh equivalent: keep the relative time fresh
  // while the clock is visible.
  $effect(() => {
    if (ts === null) return;
    const id = setInterval(() => {
      now = Date.now();
    }, 30000);
    return () => clearInterval(id);
  });

  // IRCCloud scrollDate: "dddd, MMMM dS, yyyy"
  const dateText = $derived.by(() => {
    if (!date) return '';
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dayNum = date.getDate();
    let suffix = 'th';
    if (dayNum % 10 === 1 && dayNum !== 11) suffix = 'st';
    else if (dayNum % 10 === 2 && dayNum !== 12) suffix = 'nd';
    else if (dayNum % 10 === 3 && dayNum !== 13) suffix = 'rd';
    return `${days[date.getDay()]}, ${months[date.getMonth()]} ${dayNum}${suffix}, ${date.getFullYear()}`;
  });

  // jQuery timeago wording (same vocabulary as formatRelativeTime, but
  // computed from the full timestamp rather than a day-granular date).
  const agoText = $derived.by(() => {
    if (!date) return '';
    const diff = now - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days >= 365) {
      const years = Math.floor(days / 365);
      return years === 1 ? 'about a year ago' : `${years} years ago`;
    }
    if (days >= 30) {
      const months = Math.floor(days / 30);
      return months === 1 ? 'about a month ago' : `${months} months ago`;
    }
    if (days >= 2) return `${days} days ago`;
    if (days === 1) return 'a day ago';
    if (hours >= 2) return `${hours} hours ago`;
    if (hours === 1 || minutes >= 45) return 'about an hour ago';
    if (minutes >= 2) return `${minutes} minutes ago`;
    if (minutes === 1) return 'about a minute ago';
    return 'less than a minute ago';
  });

  const fullTitle = $derived(date ? formatDateTimeTitle(date) : '');

  // ── IRCCloud canvas clock (ported verbatim from ScrollClockView) ──
  interface CircleStyle { lineWidth: number; color: string; alpha: number; radius: number; fill?: string }
  interface HandStyle { lineWidth: number; color: string; alpha: number; startAt: number; endAt: number }

  function fullCircleAt(ctx: CanvasRenderingContext2D, x: number, y: number, style: CircleStyle): void {
    ctx.save();
    ctx.globalAlpha = style.alpha;
    ctx.lineWidth = style.lineWidth;
    ctx.strokeStyle = style.color;
    ctx.translate(OFFSET, OFFSET);
    ctx.beginPath();
    ctx.arc(x, y, style.radius * RADIUS, 0, 2 * Math.PI, false);
    if (style.fill) {
      ctx.fillStyle = style.fill;
      ctx.fill();
    } else {
      ctx.stroke();
    }
    ctx.restore();
  }

  function radialLineAtAngle(ctx: CanvasRenderingContext2D, angleFraction: number, style: HandStyle): void {
    ctx.save();
    ctx.globalAlpha = style.alpha;
    ctx.lineWidth = style.lineWidth;
    ctx.strokeStyle = style.color;
    ctx.translate(RADIUS + OFFSET, RADIUS + OFFSET);
    ctx.rotate(Math.PI * (2 * angleFraction - 0.5));
    ctx.beginPath();
    ctx.moveTo(style.startAt * RADIUS, 0);
    ctx.lineTo(style.endAt * RADIUS, 0);
    ctx.stroke();
    ctx.restore();
  }

  $effect(() => {
    const d = date;
    const el = canvas;
    if (!d || !el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    // Pixel density fix (IRCCloud browser.getPixelRatio)
    const ratio = window.devicePixelRatio || 1;
    el.width = DIAMETER * ratio;
    el.height = DIAMETER * ratio;
    ctx.scale(ratio, ratio);

    const color = getComputedStyle(el).color;
    ctx.clearRect(0, 0, DIAMETER, DIAMETER);
    // Outer border
    fullCircleAt(ctx, RADIUS, RADIUS, { lineWidth: 1.3, color, alpha: 1, radius: 0.95 });
    // Hub
    fullCircleAt(ctx, RADIUS, RADIUS, { lineWidth: 1, fill: color, color, alpha: 1, radius: 0.1 });
    // Hours
    radialLineAtAngle(ctx, (d.getHours() + d.getMinutes() / 60) / 12, { lineWidth: 2, color, alpha: 1, startAt: 0, endAt: 0.6 });
    // Mins
    radialLineAtAngle(ctx, (d.getMinutes() + d.getSeconds() / 60) / 60, { lineWidth: 2, color, alpha: 1, startAt: 0, endAt: 0 });
  });
</script>

{#if ts !== null}
  <div class="dateWrapper dateChange scrollClock" title={fullTitle} aria-hidden="true">
    <table class="date">
      <tbody>
        <tr>
          <td class="scrollDate">{dateText}</td>
          <td class="clockcell"><canvas bind:this={canvas} class="clock"></canvas></td>
          <td class="timeago" title={date?.toISOString()}>{agoText}</td>
        </tr>
      </tbody>
    </table>
  </div>
{/if}

<style>
  .scrollClock {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 6;
    pointer-events: none;
  }
  table.date {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 14px;
    line-height: 18px;
    font-family: Hack, monospace;
    color: #e6e6e6;
    background: #333;
    box-shadow: inset 0 -3px 0 #4d4d4d, inset 0 -4px 0 #262626, inset 0 -1px 0 #262626;
  }
  td {
    padding: 3px 5px 8px;
    vertical-align: middle;
  }
  .scrollDate {
    text-align: right;
    width: 50%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .clockcell {
    width: 16px;
    padding-left: 0;
    padding-right: 0;
  }
  .clock {
    width: 16px;
    height: 16px;
    display: block;
  }
  .timeago {
    text-align: left;
    width: 50%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
