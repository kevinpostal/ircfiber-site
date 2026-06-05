<script lang="ts">
  import { getTotalUnread, getHasHighlight } from '../stores/ircStore.svelte';

  $effect(() => {
    const count = getTotalUnread();
    if (count > 0) {
      document.title = `(${count}) IRC Fiber`;
    } else {
      document.title = 'IRC Fiber';
    }
  });

  $effect(() => {
    updateFavicon(getTotalUnread(), getHasHighlight());
  });

  function updateFavicon(count: number, highlight: boolean): void {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#4a90d9';
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.fill();

    if (count > 0) {
      ctx.fillStyle = highlight ? '#e91e63' : '#ff5722';
      ctx.beginPath();
      ctx.arc(26, 6, 8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'white';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(count > 9 ? '9+' : String(count), 26, 7);
    }

    let link = document.querySelector("link[rel*='icon']") as HTMLLinkElement;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = canvas.toDataURL('image/png');
  }
</script>
