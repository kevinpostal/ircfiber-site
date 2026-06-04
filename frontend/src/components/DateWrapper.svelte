<script lang="ts">
  import { formatDate, formatRelativeTime, formatDateTimeTitle } from '../lib/utils';

  interface Props {
    date: string;
    title?: string;
    visible: boolean;
  }
  let { date, title = '', visible }: Props = $props();

  let clockCanvas: HTMLCanvasElement;

  function drawClock(): void {
    if (!clockCanvas) return;
    const ctx = clockCanvas.getContext('2d');
    if (!ctx) return;
    const w = 32, h = 32, r = 14, cx = 16, cy = 16;
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#262626';
    ctx.fill();
    ctx.strokeStyle = '#4d4d4d';
    ctx.lineWidth = 1;
    ctx.stroke();
    const now = new Date();
    const min = now.getMinutes();
    const hr = now.getHours() % 12 + min / 60;
    const toRad = (a: number): number => ((a - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + 6 * Math.cos(toRad(hr * 30)), cy + 6 * Math.sin(toRad(hr * 30)));
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e6e6e6';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + 9 * Math.cos(toRad(min * 6)), cy + 9 * Math.sin(toRad(min * 6)));
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = '#e6e6e6';
    ctx.fill();
  }

  $effect(() => {
    if (visible && clockCanvas) {
      drawClock();
      const interval = setInterval(drawClock, 1000);
      return () => clearInterval(interval);
    }
  });
</script>

<div class="dateWrapper dateChange" style:display={visible ? 'block' : 'none'} title={title || (date ? formatDateTimeTitle(new Date(date)) : '')}>
  <table class="date">
    <tbody>
      <tr>
        <td class="scrollDate">{date ? formatDate(date) : ''}</td>
        <td class="clockcell" style="width: 16px;">
          <canvas class="clock" style="width: 16px; height: 16px;" width="32" height="32" bind:this={clockCanvas}></canvas>
        </td>
        <td class="timeago" title={title || (date ? formatDateTimeTitle(new Date(date)) : '')}>{date ? formatRelativeTime(date) : ''}</td>
      </tr>
    </tbody>
  </table>
</div>
