<script lang="ts">
  import { getActiveBufferObj, getSortedMembers, getActiveNetwork } from '../stores/ircStore.svelte';
  import { stripPrefix, nickColorIndex } from '../lib/utils';
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
  // Members carries no symbol there, only the `•` pill and a count.
  const CATEGORY_LABELS: Record<ModeCategory, string> = {
    OPER: 'Oper',
    OWNER: 'Owner',
    ADMIN: 'Admins',
    OP: 'Ops',
    HALFOP: 'Half ops',
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
            {#if showPrefixes}
              {#if CATEGORY_SYMBOLS[category]}
                <span class="mode_prefix mode_symbol mode_{category}">{CATEGORY_SYMBOLS[category]}</span>
              {/if}
              <!-- `.memberDot` (only on Members, which has no mode char)
                   keeps the bullet visible in the default symbol
                   indicator mode; see `_accountMenu.scss`. The plain
                   pill is the dots-mode counterpart of the symbol. -->
              <span class="mode_prefix mode_pill mode_{category}"
                    class:memberDot={!CATEGORY_SYMBOLS[category]}>&bull;</span>
            {/if}
            <span class="memberCount">{members.length}</span>
          </span>
        </h2>
        <ul class="categoryMemberList">
          {#each members as member (stripPrefix(member.nick))}
            {@const nick = stripPrefix(member.nick)}
            {@const isSelf = nick === myNick}
            {@const isMatch = hoveredNick !== null && hoveredNick === nick}
            {@const sym = CATEGORY_SYMBOLS[member.category] ?? CATEGORY_SYMBOLS[category] ?? ''}
            <!-- IRCCloud splits the usermask across `data-ident_prefix`
                 (the `~` of an unidentified ident), `data-user`,
                 `data-userhost` and the joined `data-usermask`; the nick
                 colour class (`c0`–`c26`) is the same hash it uses for
                 avatars and message authors. -->
            {@const identPrefix = member.ident.startsWith('~') ? '~' : ''}
            {@const user = identPrefix ? member.ident.slice(1) : member.ident}
            {@const usermask = member.host ? `${member.ident}@${member.host}` : member.ident}
            <li class="user member-item c{nickColorIndex(nick)}"
                class:away={member.isAway} class:isSelf={isSelf} class:match={isMatch}
                data-category={category} data-mode={member.prefix}
                data-usermask={usermask} data-ident_prefix={identPrefix}
                data-user={user} data-userhost={member.host}>
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <button type="button" class="bufferLink {cssCat}"
                      class:away={member.isAway}
                      title={usermask ? `${nick} (${usermask})` : nick}
                      onclick={(e) => onNickClick?.(nick, e, member)}
                      onmouseenter={() => onNickHover?.(nick)}
                      onmouseleave={() => onNickHover?.(null)}>
                {#if showPrefixes && sym}
                  <span class="member-mode-prefix" aria-hidden="true">{sym}</span>
                {/if}
                <span class="member-nick">{nick}</span>
                {#if member.isBot}<span class="member-bot" title="Bot">BOT</span>{/if}
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
    /* Inherits the `c0`–`c26` nick colour set on the row. */
    color: inherit;
  }
  .member-bot {
    display: inline-block;
    background: rgba(255,255,255,0.1);
    color: var(--text-tertiary);
    font-size: 9px;
    font-weight: 700;
    padding: 1px 3px;
    border-radius: 3px;
    vertical-align: middle;
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
  /* Self is emphasised by weight only — the nick keeps its own colour,
     exactly as IRCCloud renders the logged-in user's row. */
  :global(.member-item.isSelf .member-nick) { font-weight: 600; }
  :global(.member-item.match) { background: rgba(88,166,255,.08); border-left: 3px solid #58a6ff; }
</style>
