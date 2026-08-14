<script lang="ts">
  import type { IRCMessage } from '../types';

  interface Props {
    type?: 'focus' | 'bottom' | 'last';
    networkId?: string;
    bufferName?: string;
    msg?: IRCMessage | null;
    prevMsg?: IRCMessage | null;
    sameAuthor?: boolean;
  }
  let { type = 'focus', networkId, bufferName, msg, sameAuthor = false }: Props = $props();

  // IRCCloud parity: labels from common-5650bddb.js
  //   focus  → "New messages since you tabbed out"  (renderFocusSeenDivider)
  //   bottom → "New messages since you scrolled up" (renderBottomSeenDivider)
  //   last   → "New messages"                       (renderLastSeenDivider)
  const label = $derived(
    type === 'focus'
      ? 'New messages since you tabbed out'
      : type === 'bottom'
      ? 'New messages since you scrolled up'
      : 'New messages'
  );
  const eid = $derived(msg?.eid ?? msg?.msgid ?? '');
  const t = $derived(msg?.t ?? 0);
</script>

<div
  class="row seenDivider"
  class:focusSeen={type === 'focus'}
  class:bottomSeen={type === 'bottom'}
  class:lastSeen={type === 'last'}
  class:sameAuthor={sameAuthor}
  data-cid={networkId}
  data-bid={bufferName}
  data-eid={eid}
  data-time={t}
>
  <hr />
  <h4 class="divider-text-wrapper">
    <span class="divider-text">{label}</span>
  </h4>
</div>
