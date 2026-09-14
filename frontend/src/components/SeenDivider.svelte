<script lang="ts">
  import type { IRCMessage } from '../types';

  interface Props {
    type?: 'bottom' | 'last';
    networkId?: string;
    bufferName?: string;
    msg?: IRCMessage | null;
    prevMsg?: IRCMessage | null;
    sameAuthor?: boolean;
  }
  let { type = 'last', networkId, bufferName, msg, sameAuthor = false }: Props = $props();

  // IRCCloud parity: labels from common-5650bddb.js
  //   bottom → "New messages since you scrolled up" (renderBottomSeenDivider)
  //   last   → "New messages"                       (renderLastSeenDivider)
  // IRCCloud's focusSeen ("since you tabbed out") variant is deliberately
  // not rendered by MessageList, so there is no label for it.
  const label = $derived(
    type === 'bottom' ? 'New messages since you scrolled up' : 'New messages'
  );
  const eid = $derived(msg?.eid ?? msg?.msgid ?? '');
  const t = $derived(msg?.t ?? 0);
</script>

<div
  class="row seenDivider"
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
