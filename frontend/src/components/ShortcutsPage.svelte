<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';
  import { navigateBackFromShortcuts } from '../lib/routing';

  function close(): void {
    ircState.showShortcuts = false;
    navigateBackFromShortcuts();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  type ShortcutItem = {
    keys: string[];
    description: string | string[];
  };

  type ShortcutGroup = {
    heading?: string;
    items: ShortcutItem[];
    twoCol?: boolean;
  };

  const mainShortcuts: ShortcutItem[] = [
    { keys: ['Alt', '↑'], description: 'Switch to previous buffer' },
    { keys: ['Alt', '↓'], description: 'Switch to next buffer' },
    { keys: ['Esc'], description: 'Close dialog' },
  ];

  const inputShortcuts: ShortcutItem[] = [
    { keys: ['Tab'], description: ['Complete nicknames, channels and topics e.g. for replying and ', '/msg', ' ', '/join', ' ', '/mode', ' ', '/topic'] },
    { keys: ['↑/↓'], description: 'Browse message input history' },
    { keys: ['Enter'], description: 'Send message' },
    { keys: ['Shift', 'Enter'], description: 'Insert a new line instead of sending a message' },
    { keys: ['Alt', 'Enter'], description: 'Insert a new line instead of sending a message' },
    { keys: [], description: ['Send a raw ', '/command'] },
  ];

  const commandShortcuts: ShortcutItem[] = [
    { keys: ['/nick', '[nickname]'], description: 'Change your nickname' },
    { keys: ['/me', '[message]'], description: 'Send message as an action' },
    { keys: ['/msg', 'nickname', '[message]'], description: ['Send a private message to another user (', '/query', ' or ', '/m', ' or ', '/q', ')'] },
    { keys: ['/join', '[channel', '[pass]]'], description: ['Join a channel (', '/channel', ' or ', '/j', ')'] },
    { keys: ['/part', '[channel]'], description: ['Leave a channel (', '/leave', ' or ', '/pa', ' or ', '/p', ' or ', '/l', ')'] },
    { keys: ['/cycle', '[channel', '[pass]]'], description: ['Rejoin a channel (', '/hop', ' or ', '/rejoin', ')'] },
    { keys: ['/clear'], description: 'Clears the current backlog (can be restored with a button)' },
    { keys: ['/archive'], description: ['Archive a channel or conversation (', '/close', ' or ', '/wc', ' or ', '/a', ')'] },
    { keys: ['/unarchive'], description: 'Unarchive a channel or conversation' },
    { keys: ['/delete'], description: ['Delete a channel or conversation (', '/wd', ' or ', '/rm', ')'] },
    { keys: ['/quit', '[message]'], description: ['Disconnect from a server (', '/disconnect', ')'] },
    { keys: ['/umode', '[mode', 'string]'], description: ['Set or check your own mode string (shortcut for /mode ', 'yournick', ')'] },
    { keys: ['/reconnect'], description: 'Reconnect to a server' },
    { keys: ['/topic', '[topic]'], description: 'Set the channel topic' },
    { keys: ['/away', '[message]'], description: 'Set an away message' },
    { keys: ['/back'], description: 'Clear your away status' },
    { keys: ['/highlight', '[words]'], description: ['Add words to your highlight list (', '/hilight', ')'] },
    { keys: ['/unhighlight', '[words]'], description: ['Remove words from your highlight list (', '/unhilight', ' or ', '/dehighlight', ' or ', '/dehilight', ')'] },
    { keys: ['/invite', '[nickname]'], description: 'Invite a user to a channel' },
    { keys: ['/whois', '[nickname]'], description: ['Get more information on a user (', '/wi', ')'] },
    { keys: ['/ignore', '[usermask]'], description: 'Ignore someone (per connection) or list ignores' },
    { keys: ['/unignore', '[usermask]'], description: 'Stop ignoring someone' },
    { keys: ['/op', '[nickname]'], description: 'Make a user a channel operator' },
    { keys: ['/deop', '[nickname]'], description: "Revoke a user's ops in a channel" },
    { keys: ['/voice', '[nickname]'], description: 'Give a user voice in a channel' },
    { keys: ['/devoice', '[nickname]'], description: "Revoke a user's voice in a channel" },
    { keys: ['/kick', '[nickname]', '[reason]'], description: 'Kick a user from a channel' },
    { keys: ['/ban', '[banmask]'], description: 'Ban someone from a channel or list bans' },
    { keys: ['/unban', '[banmask]'], description: 'Remove a channel ban' },
    { keys: ['/kickban', '[nickname]', '[reason]'], description: ['Kick and ban a user from a channel (', '/kb', ')'] },
    { keys: ['/raw', '[command]'], description: ['Send a raw IRC command to the server (', '/quote', ')'] },
  ];

  const groups: ShortcutGroup[] = [
    { items: mainShortcuts },
    { heading: 'Message input', items: inputShortcuts },
    { heading: 'Selected IRC commands', items: commandShortcuts, twoCol: true },
  ];

  function renderDescription(desc: string | string[]): string | { tag: 'kbd' | 'text'; text: string; key: number }[] {
    if (typeof desc === 'string') return desc;
    return desc.map((part, i) =>
      part.startsWith('/') || part === 'yournick'
        ? { tag: 'kbd', text: part, key: i }
        : { tag: 'text', text: part, key: i }
    );
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="shortcuts-overlay">
  <div class="shortcuts-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <button type="button" class="shortcuts-close" onclick={close}>
      <span>Close</span>
    </button>

    <div class="shortcuts">
      <h2 class="shortcuts-title">Keyboard shortcuts <kbd>?</kbd></h2>

      {#each groups as group}
        {#if group.heading}
          <h3 class="shortcuts-heading">{group.heading}</h3>
        {/if}
        <div class="shortcuts-group" class:two-col={group.twoCol}>
          {#each group.items as item}
            <div class="shortcut">
              <div class="shortcut-keys">
                {#if item.keys.length > 0}
                  {#if item.keys[0].startsWith('/')}
                    <kbd>{item.keys.join(' ')}</kbd>
                  {:else}
                    {#each item.keys as key, i}
                      <kbd>{key}</kbd>{#if i < item.keys.length - 1}&nbsp;{/if}
                    {/each}
                  {/if}
                {/if}
              </div>
              <div class="shortcut-desc">
                {#if typeof item.description === 'string'}
                  {item.description}
                {:else}
                  {#each renderDescription(item.description) as part (part.key)}
                    {#if part.tag === 'kbd'}
                      <kbd>{part.text}</kbd>
                    {:else}
                      {part.text}
                    {/if}
                  {/each}
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .shortcuts-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.6);
    overflow: auto;
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }

  .shortcuts-modal {
    position: relative;
    margin: 16px;
    padding: 14px 18px;
    width: 100%;
    max-width: 1000px;
    max-height: calc(100vh - 32px);
    overflow: auto;
    background: #333;
    color: #e6e6e6;
    font-size: 12.5px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-sizing: border-box;
  }

  .shortcuts-close {
    position: sticky;
    top: 0;
    float: right;
    margin: 0 0 4px 8px;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    z-index: 2;
  }

  .shortcuts-close span {
    display: inline-block;
    padding: 3px 9px;
    background: #679fff;
    color: #fff;
    border-radius: 3px;
    font-size: 11px;
    font-family: inherit;
  }

  .shortcuts {
    color: #e6e6e6;
    font-size: 12.5px;
  }

  .shortcuts-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: #e6e6e6;
  }

  .shortcuts-title kbd {
    margin-left: 4px;
  }

  .shortcuts-heading {
    margin: 12px 0 0;
    font-size: 12.5px;
    font-weight: 600;
    color: #e6e6e6;
  }

  .shortcuts-group {
    display: grid;
    grid-template-columns: 200px 1fr;
    column-gap: 16px;
    row-gap: 0;
  }

  .shortcuts-group.two-col {
    grid-template-columns: 200px 1fr 200px 1fr;
    column-gap: 16px;
  }

  .shortcut {
    display: contents;
  }

  .shortcut-keys {
    padding: 2px 0;
    white-space: nowrap;
    text-align: left;
  }

  .shortcut-desc {
    padding: 2px 0;
    line-height: 1.35;
  }

  kbd {
    display: inline-block;
    padding: 0 5px;
    background: #555;
    color: #fff;
    border-radius: 3px;
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    line-height: 1.5;
  }
</style>
