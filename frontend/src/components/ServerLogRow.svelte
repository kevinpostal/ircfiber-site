<script lang="ts">
  // One visual row of the IRCCloud-style server log. Markup and CSS
  // follow site/docs/mockups/server-log-irccloud.html; the row model is
  // built by lib/serverLogRows.ts. The only local state is the two
  // disclosure toggles (ISUPPORT clamp, MOTD fold) — they live here so a
  // re-built row list keeps them as long as the row key is stable.
  import type { IRCMessage } from '../types';
  import type { ServerLogRow } from '../lib/serverLogRows';
  import { relativeOffset, formatOffset } from '../lib/serverLogGroups';
  import { formatTime12Hour, formatDateTimeTitle, escapeHtml } from '../lib/utils';
  import LiveElapsed from './LiveElapsed.svelte';

  interface Props {
    row: ServerLogRow;
  }
  let { row }: Props = $props();

  let isupOpen = $state(false);
  let motdCollapsed = $state(false);

  function stamp(msg: IRCMessage): { time: string; title: string } {
    const ts = msg.timestamp || (msg.t ? new Date(msg.t).toISOString() : null);
    if (!ts) return { time: '--:--:--', title: '' };
    const d = new Date(ts);
    return { time: formatTime12Hour(d), title: formatDateTimeTitle(d) };
  }

  const liveOffset = (ms: number): string => `+${formatOffset(ms)}`;
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
  <div class="row part"><hr /></div>
{:else if row.kind === 'status'}
  <div class="row status" class:muted={row.muted} data-cmd={row.msg.command} data-time={row.msg.t}>
    <span class="content">{@html row.html}</span>
    {@render date(row.msg)}
  </div>
{:else if row.kind === 'isup'}
  <div class="row status muted isup" class:open={isupOpen} data-cmd="005" data-time={row.msg.t}>
    <span class="content">Server supports: {#each row.tokens as tok, i (tok + i)}{@const eq = tok.indexOf('=')}{#if i > 0}{' '}{/if}<b>{eq === -1 ? tok : tok.slice(0, eq)}</b>{#if eq !== -1}={tok.slice(eq + 1)}{/if}{/each}</span>
    <button type="button" class="more" onclick={() => { isupOpen = !isupOpen; }}>{isupOpen ? 'less' : '…more'}</button>
    {@render date(row.msg)}
  </div>
{:else if row.kind === 'motd'}
  <div class="row grouped" data-time={row.msg.t}>
    <div class="groupedLines" class:collapsed={motdCollapsed}>
      <h2>
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
        <div class="l">{@html line || '&nbsp;'}</div>
      {/each}
    </div>
  </div>
{:else if row.kind === 'notice'}
  <div class="row notice" class:srv={row.server} data-time={row.lines[0]?.msg.t}>
    <div class="author">
      <span class="av" class:srv={row.server}>{row.server ? '⌘' : row.author.charAt(0).toUpperCase()}</span>
      <span class="name">{row.author}</span>
      {#if row.bot}<span class="bot">BOT</span>{/if}
    </div>
    {#each row.lines as line (line.key)}
      <div class="line" data-time={line.msg.t}>{@html line.html || escapeHtml(line.msg.text ?? '')}{@render date(line.msg)}</div>
    {/each}
  </div>
{/if}

<style>
  /* ── base row (mockup .row / .content / .date) ──────────────────── */
  .row {
    position: relative;
    padding: 0 150px 0 12px;
    font: 14px/19px var(--font-mono);
  }
  .row .date {
    position: absolute;
    right: 12px;
    top: 0;
    width: 90px;
    text-align: right;
    font-size: 12px;
    line-height: 19px;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    user-select: none;
    white-space: nowrap;
  }
  .row:has(.date:hover) { box-shadow: inset 5px 0 0 0 var(--accent); }
  .row .content {
    color: #9cbfe2; /* IRCCloud dusk div.status content */
    white-space: pre-wrap;
    word-break: break-word;
  }
  .row.status { background: rgba(255, 255, 255, 0.015); }
  .row.status :global(b) { color: #b0cce8; }
  .row.muted .content { color: var(--text-tertiary); }
  .row :global(.kv) { color: var(--text-tertiary); }
  .row :global(.kv b) { color: var(--text-secondary); font-weight: 500; }
  .row :global(.disco) { color: #ff8f8a; }

  /* IRCCloud div.part hr — socket closed divider */
  .row.part { padding: 0; }
  .row.part hr { border: 0; border-top: 3px double #444a52; margin: 6px 12px; }

  /* ── phase rows: a thin rail joins the steps of one attempt ─────── */
  .row.phase { padding-left: 36px; }
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
  .row.phase .content { color: var(--text-primary); }
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

  /* ── notices (server / services) — IRCCloud notice row w/ author ── */
  /* Right padding moves to each .line so every line's timestamp shares
     the .row .date column (right: 12px of the row box). */
  .row.notice { padding: 0 0 0 12px; margin-top: 4px; }
  .row.notice .author { display: flex; gap: 8px; align-items: center; margin-bottom: 1px; }
  .row.notice .av {
    width: 18px;
    height: 18px;
    border-radius: 3px;
    background: #7c3aed;
    color: #fff;
    font: 700 11px/18px var(--font-sans, sans-serif);
    text-align: center;
  }
  .row.notice .av.srv { background: #30363d; color: #9cbfe2; font-size: 10px; }
  .row.notice .name { font-weight: 600; color: #e6edf3; }
  .row.notice .bot {
    font: 600 9px/12px var(--font-sans, sans-serif);
    padding: 0 4px;
    border-radius: 2px;
    background: #30363d;
    color: #c9d1d9;
  }
  .row.notice .line {
    position: relative;
    padding: 0 150px 0 26px;
    color: #9cbfe2;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ── grouped MOTD block ─────────────────────────────────────────── */
  .row.grouped { padding: 4px 12px; }
  .groupedLines {
    display: block;
    position: relative;
    background: #1d4063; /* IRCCloud dusk groupedLines */
    border-radius: 3px;
    padding: 5px 8px;
    color: #dbe9f7;
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
  .groupedLines .l {
    min-height: 17px;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
  }
  .groupedLines.collapsed .l { display: none; }

  /* ── isupport: one row, 2-line clamp, expandable ────────────────── */
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
    background: var(--chat-bg, #000);
    padding-left: 6px;
    line-height: 19px;
  }
</style>
