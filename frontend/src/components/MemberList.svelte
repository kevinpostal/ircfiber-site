<script lang="ts">
  import { getActiveBufferObj, getSortedMembers, getActiveNetwork } from '../stores/ircStore.svelte';
  import { stripPrefix } from '../lib/utils';
  import type { ModeCategory, Member } from '../types';
  import { getShowMemberPrefixes } from '../stores/preferences.svelte';

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

  // Section headings and symbols, from IRCCloud's member list
  // (`li.category > h2`): Oper, Owner, Admins, Ops, Half ops, Voiced,
  // Members. `*` is this network's operprefix char (see MODE_PREFIX_MAP);
  // Members carries no symbol there, only a count.
  //
  // One deliberate divergence: halfop reads as "Staff" here. On IRC Fiber
  // `+h` is what the staff group holds (ircd_channel_access.hop in the
  // ircd role), so the section says who they are rather than which mode
  // letter they were given. The prefix char stays `%` and the band keeps
  // the `halfops` class, so nothing else has to know.
  const CATEGORY_LABELS: Record<ModeCategory, string> = {
    OPER: 'Oper',
    OWNER: 'Owner',
    ADMIN: 'Admins',
    OP: 'Ops',
    HALFOP: 'Staff',
    VOICED: 'Voiced',
    MEMBER: 'Members',
  };

  const CATEGORY_SYMBOLS: Record<ModeCategory, string> = {
    OPER: '*',
    OWNER: '~',
    ADMIN: '&',
    OP: '@',
    HALFOP: '%',
    VOICED: '+',
    MEMBER: '',
  };

  /** One CSS class per category, matching IRCCloud's `li.category.<cls>`.
   *  Collapsing OPER/OWNER/ADMIN into `ops` (as this did) is why a `&`
   *  services bot rendered inside a red "Ops" band. */
  const CATEGORY_CLASSES: Record<ModeCategory, string> = {
    OPER: 'oper',
    OWNER: 'owner',
    ADMIN: 'admin',
    OP: 'ops',
    HALFOP: 'halfops',
    VOICED: 'voiced',
    MEMBER: 'members',
  };

  const sortedMembers = $derived(getSortedMembers());
  const showPrefixes = $derived(getShowMemberPrefixes());
</script>

<div class="memberwrapper" id="flat-members">
  <ul class="memberList">
    {#each [...sortedMembers.entries()] as [category, members] (category)}
      {@const cssCat = CATEGORY_CLASSES[category]}
      <li class="category {cssCat}">
        <h2>
          {CATEGORY_LABELS[category]}
          <span class="memberExtras">
            {#if showPrefixes && CATEGORY_SYMBOLS[category]}
              <span class="mode_prefix mode_symbol mode_{category}">{CATEGORY_SYMBOLS[category]}</span>
              <span class="mode_prefix mode_pill mode_{category}">&bull;</span>
            {/if}
            <span class="memberCount">{members.length}</span>
          </span>
        </h2>
        <ul class="categoryMemberList">
          {#each members as member (stripPrefix(member.nick))}
            {@const nick = stripPrefix(member.nick)}
            {@const isSelf = nick === myNick}
            {@const isMatch = hoveredNick !== null && hoveredNick === nick}
            <li class="user member-item" class:away={member.isAway} class:isSelf={isSelf} class:match={isMatch} data-category={category} data-mode={member.prefix}>
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <button type="button" class="bufferLink {cssCat}"
                      class:away={member.isAway}
                      title={member.ident ? `${nick} (${member.ident})` : nick}
                      onclick={(e) => onNickClick?.(nick, e, member)}
                      onmouseenter={() => onNickHover?.(nick)}
                      onmouseleave={() => onNickHover?.(null)}>
                {#if showPrefixes}
                  <span class="member-mode-prefix" aria-hidden="true">{CATEGORY_SYMBOLS[member.category] ?? CATEGORY_SYMBOLS[category] ?? ''}</span>
                {/if}
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
    color: #777;
  }
  /* IRCCloud's `span.mode_prefix.mode_*` values. Set on this span rather
     than inherited because the row's button fixes its own `color` for the
     nick and its hover state. */
  :global(.member-item[data-category="OPER"] .member-mode-prefix) { color: #e02305; }
  :global(.member-item[data-category="OWNER"] .member-mode-prefix) { color: #e7aa00; }
  :global(.member-item[data-category="ADMIN"] .member-mode-prefix) { color: #6500a5; }
  :global(.member-item[data-category="OP"] .member-mode-prefix) { color: #ba1719; }
  :global(.member-item[data-category="HALFOP"] .member-mode-prefix) { color: #b55900; }
  :global(.member-item[data-category="VOICED"] .member-mode-prefix) { color: #25b100; }
  :global(.member-item.away) { opacity: .5; }
  :global(.member-item.isSelf .member-nick) { font-weight: 600; color: #fff; }
  :global(.member-item.match) { background: rgba(88,166,255,.08); border-left: 3px solid #58a6ff; }
</style>
