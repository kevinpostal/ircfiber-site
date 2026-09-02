<script lang="ts">
  // IRCCloud title (@830300) + favicon (xgw8) parity.
  //   title  = [ "(N) " | "+ " | "* " ] [ "(Offline) " ] base
  //     base = "IRC Fiber" | connectionName | "#chan | connectionName"
  //     N    = Σ unseen highlights; "+ " when the current buffer is the
  //            (tracked) unseen one, "* " when another buffer is unseen.
  //   favicon: the site icon with a red dot when any highlight is unseen.
  import { ircState, getActiveNetwork, getUnseenMessageStats, isTrackingUnread } from '../stores/ircStore.svelte';

  let titleTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const net = getActiveNetwork();
    const bufferName = ircState.activeBuffer.bufferName ?? '';
    let base = 'IRC Fiber';
    if (net && bufferName) {
      base = bufferName === '_server' ? net.name : `${bufferName} | ${net.name}`;
    }
    const stats = getUnseenMessageStats();
    let prefix = '';
    if (stats !== false) {
      if (stats) prefix = `(${stats}) `;
      else {
        const cur = net?.buffers.find(b => b.name === bufferName);
        prefix = cur && bufferName !== '_server' && isTrackingUnread(net!.networkId, bufferName) && cur.unseen ? '+ ' : '* ';
      }
    }
    if (ircState.me && !ircState.wsConnected) prefix += '(Offline) ';
    const title = prefix + base;
    document.title = title;
    // IRCCloud re-sets the title after titleDelay:500 so browsers that
    // coalesce rapid title changes still pick up the final value.
    if (titleTimer) clearTimeout(titleTimer);
    titleTimer = setTimeout(() => { document.title = ''; document.title = title; }, 500);
    return () => { if (titleTimer) clearTimeout(titleTimer); };
  });

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  let baseIcon: HTMLImageElement | null = null;
  let iconReady = false;
  let pendingHighlights = false;

  function loadBaseIcon(): void {
    if (baseIcon) return;
    baseIcon = new Image();
    baseIcon.onload = () => { iconReady = true; renderFavicon(pendingHighlights); };
    baseIcon.src = dpr > 1 ? '/favicon-32x32.png' : '/favicon-16x16.png';
  }

  function renderFavicon(highlights: boolean): void {
    if (typeof document === 'undefined') return;
    pendingHighlights = highlights;
    if (!iconReady || !baseIcon) { loadBaseIcon(); return; }
    const size = Math.round(16 * dpr);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(baseIcon, 0, 0, size, size);
    if (highlights) {
      const r = 2.5 * dpr;
      const pad = 1 * dpr;
      ctx.fillStyle = '#ff1f1a';
      ctx.beginPath();
      ctx.arc(size - r - pad, pad + r, r, 0, Math.PI * 2);
      ctx.fill();
    }
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/png"][sizes="32x32"]')
      ?? document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = canvas.toDataURL('image/png');
  }

  $effect(() => {
    const stats = getUnseenMessageStats();
    renderFavicon(stats !== false && stats > 0);
  });
</script>
