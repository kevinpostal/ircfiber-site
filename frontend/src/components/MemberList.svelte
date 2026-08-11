<script lang="ts">
  import { getActiveBufferObj, getSortedMembers, getActiveNetwork } from '../stores/ircStore.svelte';
  import { stripPrefix } from '../lib/utils';
  import type { ModeCategory, Member } from '../types';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent, member?: Member | null) => void;
    onNickHover?: (nick: string | null) => void;
    hoveredNick?: string | null;
  }
  let { onNickClick, onNickHover, hoveredNick = null }: Props = $props();

  const myNick = $derived.by(() => {
    const net = getActiveNetwork();
    return stripPrefix(net?.currentNick ?? net?.nick ?? '');
  });

  const CATEGORY_LABELS: Record<ModeCategory, string> = {
    OPER: 'IRC Operators',
    OWNER: 'Owners',
    ADMIN: 'Admins',
    OP: 'Ops',
    HALFOP: 'Half-Ops',
    VOICED: 'Voiced',
    MEMBER: 'Members',
  };

  const CATEGORY_SYMBOLS: Record<ModeCategory, string> = {
    OPER: '!',
    OWNER: '~',
    ADMIN: '&',
    OP: '@',
    HALFOP: '%',
    VOICED: '+',
    MEMBER: '•',
  };

  /** Map 7 categories down to 4 CSS classes used by existing theme */
  function cssCategory(cat: ModeCategory): string {
    if (cat === 'OP' || cat === 'OPER' || cat === 'OWNER' || cat === 'ADMIN') return 'ops';
    if (cat === 'HALFOP') return 'halfops';
    if (cat === 'VOICED') return 'voiced';
    return 'members';
  }

  const sortedMembers = $derived(getSortedMembers());
</script>

<div class="memberwrapper" id="flat-members">
  <ul class="memberList">
    {#each [...sortedMembers.entries()] as [category, members] (category)}
      {@const cssCat = cssCategory(category)}
      <li class="category {cssCat}">
        <h2>
          {CATEGORY_LABELS[category]}
          <span class="memberExtras">
            <span class="memberCount">{CATEGORY_SYMBOLS[category]}{CATEGORY_SYMBOLS[category] ? ' ' : ''}{members.length}</span>
          </span>
        </h2>
        <ul class="categoryMemberList">
          {#each members as member (stripPrefix(member.nick))}
            {@const nick = stripPrefix(member.nick)}
            {@const isSelf = nick === myNick}
            {@const isMatch = hoveredNick !== null && hoveredNick === nick}
            <li class="user member-item" class:away={member.isAway} class:isSelf={isSelf} class:match={isMatch} data-category={category}>
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <button type="button" class="bufferLink"
                      class:away={member.isAway}
                      onclick={(e) => onNickClick?.(nick, e, member)}
                      onmouseenter={() => onNickHover?.(nick)}
                      onmouseleave={() => onNickHover?.(null)}>
                <span class="member-mode-prefix" aria-hidden="true">{CATEGORY_SYMBOLS[member.category] ?? CATEGORY_SYMBOLS[category] ?? ''}</span>
                <span class="member-nick">{nick}</span>
              </button>
            </li>
          {/each}
        </ul>
      </li>
    {/each}
  </ul>
</div>

<style>
  .member-nick {
    vertical-align: middle;
    color: #ccc;
  }
  .author-realname {
    color: #737373;
    font-size: 12px;
    font-weight: 400;
    margin-left: 6px;
    vertical-align: middle;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button.bufferLink {
    display: inline-flex !important;
    align-items: center;
    gap: 4px;
  }
  .member-mode-prefix {
    width: 14px;
    flex-shrink: 0;
    text-align: center;
    font: 600 12px/1 var(--font-mono, ui-monospace, monospace);
    color: #6e7681;
  }
  /* Mode colors — mirror MessageRow .mode_prefix but scoped to member list */
  :global(.member-item[data-category="OWNER"] .member-mode-prefix),
  :global(.member-item[data-category="OPER"] .member-mode-prefix) { color: rgb(255,99,71); }
  :global(.member-item[data-category="ADMIN"] .member-mode-prefix) { color: rgb(181,145,0); }
  :global(.member-item[data-category="OP"] .member-mode-prefix) { color: rgb(50,205,50); }
  :global(.member-item[data-category="HALFOP"] .member-mode-prefix) { color: rgb(181,89,0); }
  :global(.member-item[data-category="VOICED"] .member-mode-prefix) { color: rgb(0,191,255); }
  :global(.member-item.away) { opacity: .5; }
  :global(.member-item.isSelf .member-nick) { font-weight: 600; color: #fff; }
  :global(.member-item.match) { background: rgba(88,166,255,.08); border-left: 3px solid #58a6ff; }
</style>
