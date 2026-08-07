<script lang="ts">
  import { getActiveBufferObj, getSortedMembers } from '../stores/ircStore.svelte';
  import { stripPrefix } from '../lib/utils';
  import type { ModeCategory, Member } from '../types';

  interface Props {
    onNickClick?: (nick: string, event: MouseEvent, member?: Member | null) => void;
  }
  let { onNickClick }: Props = $props();

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
            {@const rn = (member.realname || '').trim()}
            {@const sensibleRn = rn && rn.toLowerCase() !== 'realname' && rn.toLowerCase() !== 'unknown' && rn !== nick ? rn : ''}
            <!-- Display the bare nick (stripped of prefix chars and
                 !user@host). Operator/voice status is conveyed by the
                 category header above (Ops / Voiced / Half-Ops / Members)
                 which is driven by `member.category`; the inline prefix
                 char is no longer shown next to the nick. The each-block
                 key and click handler still use the stripped form. -->
            <li class="user" class:away={member.isAway}>
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <button type="button" class="bufferLink"
                      class:away={member.isAway}
                      onclick={(e) => onNickClick?.(nick, e, member)}>
                <span class="member-nick">{nick}</span>
                {#if sensibleRn}
                  <span class="author-realname">{sensibleRn}</span>
                {/if}
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
    gap: 0;
  }
</style>
