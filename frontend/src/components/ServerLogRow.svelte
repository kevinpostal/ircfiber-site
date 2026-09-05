<script lang="ts">
  // One visual row of the IRCCloud-style server log. Non-phase rows emit
  // the same messageRow markup contract as the channel view (app.css
  // `.row.messageRow.status`, _joinPartRows.scss, _nickColors.scss,
  // _rowStates.scss, _discoGroups.scss and the themes own the styling);
  // the phase rail is our one deliberate divergence and keeps its local
  // CSS. The row model is built by lib/serverLogRows.ts. Local state is
  // the disclosure toggles (ISUPPORT clamp, MOTD fold, disco group) —
  // they live here so a re-built row list keeps them as long as the row
  // key is stable.
  import type { IRCMessage } from '../types';
  import type { ServerLogRow } from '../lib/serverLogRows';
  import { relativeOffset, formatOffset } from '../lib/serverLogGroups';
  import { formatTime12Hour, formatDateTimeTitle, escapeHtml, nickColorIndex } from '../lib/utils';
  import LiveElapsed from './LiveElapsed.svelte';
  import Self from './ServerLogRow.svelte';

  interface Props {
    row: ServerLogRow;
  }
  let { row }: Props = $props();

  let isupOpen = $state(false);
  let motdCollapsed = $state(false);
  let discoOpen = $state(false);

  function stamp(msg: IRCMessage): { time: string; title: string } {
    const ts = msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null);
    if (!ts) return { time: '--:--:--', title: '' };
    const d = new Date(ts);
    return { time: formatTime12Hour(d), title: formatDateTimeTitle(d) };
  }

  const liveOffset = (ms: number): string => `+${formatOffset(ms)}`;

  function usermaskOf(msg: IRCMessage): string | undefined {
    const p = msg.prefix ?? '';
    return p.includes('!') ? p.slice(p.indexOf('!') + 1) : undefined;
  }
</script>

{#snippet date(msg: IRCMessage)}
  {@const s = stamp(msg)}
  <span class="date"><span class="timestamp" title={s.title}>{s.time}</span></span>
{/snippet}

{#if row.kind === 'phase'}
  <div
    class="row phase {row.state}"
    class:first={row.first}
    class:last={row.last}
    data-phase={row.msg.phase}
    data-time={row.msg.t}
  >
    <span class="glyph"></span>
    <span class="content">{row.text}{#if row.tag}<span class="tag ok">{row.tag}</span>{/if}</span>
    <span class="offs" class:hot={row.state === 'live'}>
      {#if row.state === 'live' && row.startT}
        <LiveElapsed since={row.startT} format={liveOffset} interval={100} />
      {:else}
        {relativeOffset(row.startT, row.msg.t)}
      {/if}
    </span>
    {@render date(row.msg)}
  </div>
{:else if row.kind === 'part'}
  <div class="row part type_socket_closed userParent"><hr /></div>
{:else if row.kind === 'status'}
  <div class="row messageRow status monospace {row.cls} userParent" data-cmd={row.msg.command} data-time={row.msg.t}>
    <span class="g">&nbsp;</span>
    <span class="message"><span translate="no" class="content">{@html row.html}</span></span>
    {@render date(row.msg)}
  </div>
{:else if row.kind === 'isup'}
  <div class="row messageRow status monospace type_server_supports userParent isup" class:open={isupOpen} data-cmd="005" data-time={row.msg.t}>
    <span class="g">&nbsp;</span>
    <span class="message"><span translate="no" class="content">Server supports: {#each row.tokens as tok, i (tok + i)}{@const eq = tok.indexOf('=')}{#if i > 0}{' '}{/if}<b>{eq === -1 ? tok : tok.slice(0, eq)}</b>{#if eq !== -1}={tok.slice(eq + 1)}{/if}{/each}</span></span>
    <button type="button" class="more" onclick={() => { isupOpen = !isupOpen; }}>{isupOpen ? 'less' : '…more'}</button>
    {@render date(row.msg)}
  </div>
{:else if row.kind === 'motd'}
  <div class="row messageRow type_motd_response userParent" data-time={row.msg.t}>
    <div class="groupedLines" class:collapsed={motdCollapsed}>
      <h2 class="groupedLines__line">
        <span class="motdTitle">
          {#if row.host}
            {@const idx = row.header.indexOf(row.host)}
            {#if idx >= 0}
              {row.header.slice(0, idx)}<a class="host" href="https://{row.host}" target="_blank" rel="noopener noreferrer">{row.host}</a>{row.header.slice(idx + row.host.length)}
            {:else}
              {row.header}
            {/if}
          {:else}
            {row.header}
          {/if}
        </span>
        <button type="button" class="tog" onclick={() => { motdCollapsed = !motdCollapsed; }}>
          {motdCollapsed ? `show ${row.lines.length} lines` : 'hide'}
        </button>
      </h2>
      {#each row.lines as line, i (i)}
        <div class="groupedLines__line">{@html line || '&nbsp;'}</div>
      {/each}
    </div>
  </div>
{:else if row.kind === 'notice'}
  <div class="row messageRow notice type_notice userParent {row.first ? 'firstAuthor' : 'sameAuthor'}"
       class:bot={row.bot} data-time={row.msg.t}
       data-name={row.server ? undefined : row.author}
       data-usermask={usermaskOf(row.msg)}>
    {#if !row.server}
      {@const cls = `c${nickColorIndex(row.author)}`}
      <span class="avatar letterAvatar messageAvatar hasUserParent {cls}"><span role="presentation">{row.author.charAt(0).toUpperCase()}</span></span>
    {/if}
    <span class="g">&nbsp;</span>
    <span class="message">
      {#if !row.server}
        {@const cls = `c${nickColorIndex(row.author)}`}
        <span translate="no" class="authorWrap">
          <span class="g" aria-hidden="true">&lt;</span>
          <span class="buffer bufferLink author {cls} user hasUserParent link" title={row.author}>{row.author}</span>
          <span class="g" aria-hidden="true">&gt;</span>
          {#if row.bot}<span class="author-bot">BOT</span>{/if}
        </span>
      {/if}
      <span translate="no" class="content">{@html row.html || escapeHtml(row.msg.text ?? '')}</span>
    </span>
    {@render date(row.msg)}
  </div>
{:else if row.kind === 'disco'}
  <div role="button" aria-expanded={discoOpen} tabindex="0"
       class="row messageRow groupedDisco {discoOpen ? 'expanded' : 'collapsedHead'}"
       data-time={row.msg.t}
       onclick={() => { discoOpen = !discoOpen; }}
       onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); discoOpen = !discoOpen; } }}>
    <span class="g">&nbsp;</span>
    <span class="message">
      <span translate="no" class="content"><span class="collapseWidget" aria-label="Disconnections">
          <i class="fa-regular fa-square-minus collapseIcon"></i>
          <i class="fa-regular fa-square-plus expandIcon"></i>
          <i class="fa-solid fa-angle-right collapsedIcon"></i>
        </span><span class="sentence">{@html row.sentences}</span></span>
    </span>
    {@render date(row.msg)}
  </div>
  {#if discoOpen}
    <div class="collapseGroup discoGroup">
      {#each row.rows as inner (inner.key)}<Self row={inner} />{/each}
    </div>
  {/if}
  <div class="row part groupedDiscoPart"><hr /></div>
{/if}

<style>
  /* ── phase rows: kept local — a thin rail joins the steps of one
     attempt (deliberate divergence from IRCCloud's console). The base
     layout (mono font, absolute date column) that other rows now get
     from the global messageRow CSS is scoped here to .row.phase. ────── */
  .row.phase {
    position: relative;
    padding: 0 150px 0 36px;
    font: 14px/19px var(--font-mono);
  }
  /* Same box as the global `.row.messageRow .date` (right: 0 + 10px
     padding) so phase and messageRow timestamps share one column. */
  .row.phase .date {
    position: absolute;
    right: 0;
    padding-right: 10px;
    top: 0;
    text-align: right;
    font-size: 12px;
    line-height: 19px;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    user-select: none;
    white-space: nowrap;
  }
  .row.messageRow:has(.date:hover),
  .row.phase:has(.date:hover) { box-shadow: inset 5px 0 0 0 var(--accent); }
  .row :global(.kv) { color: var(--text-tertiary); }
  .row :global(.kv b) { color: var(--text-secondary); font-weight: 500; }
  .row :global(.disco) { color: var(--status-disconnected); }

  .row.phase::before {
    content: '';
    position: absolute;
    left: 19px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: #2c3540;
  }
  .row.phase.first::before { top: 9px; }
  .row.phase.last::before { bottom: 10px; }
  .row.phase .glyph {
    position: absolute;
    left: 14px;
    top: 4px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--chat-bg, #000);
    border: 1.5px solid #4b5563;
    box-sizing: border-box;
  }
  .row.phase.done .glyph { border-color: #4b5563; background: #4b5563; }
  .row.phase.ok .glyph { border-color: #3fb950; background: #3fb950; box-shadow: 0 0 0 3px rgba(63, 185, 80, 0.18); }
  .row.phase.bad .glyph { border-color: #f85149; background: #f85149; box-shadow: 0 0 0 3px rgba(248, 81, 73, 0.18); }
  .row.phase.live .glyph { border-color: var(--accent); background: transparent; }
  .row.phase.live .glyph::after {
    content: '';
    position: absolute;
    inset: -1.5px;
    border-radius: 50%;
    border: 1.5px solid transparent;
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .row.phase .content {
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .row.phase.done .content { color: var(--text-secondary); }
  .row.phase.ok .content { color: #7ee2a8; font-weight: 600; }
  .row.phase.bad .content { color: #ff8f8a; font-weight: 600; }
  .row.phase.live .content { color: #fff; }
  .offs {
    position: absolute;
    right: 106px;
    top: 0;
    font-size: 11px;
    line-height: 19px;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  .offs.hot { color: #9cc7ff; }
  .tag {
    display: inline-block;
    font-size: 11px;
    line-height: 15px;
    padding: 0 5px;
    border-radius: 3px;
    background: #1e2126;
    color: #9cbfe2;
    margin-left: 6px;
    vertical-align: 1px;
    font-weight: 400;
  }
  .tag.ok { color: #7ee2a8; }

  /* ── grouped MOTD block (IRCCloud groupedLines) ─────────────────── */
  .row.type_motd_response { padding: 4px 12px; }
  .groupedLines {
    display: block;
    position: relative;
    background: var(--row-status-bg);
    border-radius: 3px;
    padding: 5px 8px;
    color: var(--row-mono-fg);
  }
  .groupedLines h2 {
    margin: 0 0 6px;
    font: 600 14px/19px var(--font-mono);
    color: #fff;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .groupedLines h2 .host { color: inherit; text-decoration: underline; }
  .groupedLines h2 .tog,
  .isup .more {
    font: 11px var(--font-sans, sans-serif);
    color: #9cc7ff;
    cursor: pointer;
    font-weight: 500;
    background: none;
    border: 0;
    padding: 0;
  }
  .groupedLines div.groupedLines__line {
    min-height: 17px;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
  }
  .groupedLines.collapsed div.groupedLines__line { display: none; }

  /* ── isupport: one row, 2-line clamp, expandable ────────────────── */
  /* Widen the right gutter past the global 118px so the `…more` toggle
     sits between the clamped text and the timestamp. */
  .isup.row.messageRow.status { padding-right: 160px; }
  .isup .content {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .isup.open .content { display: block; }
  .isup .more {
    position: absolute;
    right: 106px;
    bottom: 0;
    background: var(--row-status-bg);
    padding-left: 6px;
    line-height: 19px;
  }
</style>
