import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import LoadMore from './LoadMore.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { clearedAtMap } from '../stores/preferences.svelte';

describe('LoadMore', () => {
  beforeEach(() => {
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    ircState.messages = {};
    Object.keys(clearedAtMap).forEach((k) => delete (clearedAtMap as Record<string, unknown>)[k]);
  });

  it('shows nothing when clearedAt is set (backlog cleared)', async () => {
    // When clearedAt is set, the component renders an empty fragment
    // because there's no history to load. IRCCloud hides the loadMore
    // row until the user interacts with the "Backlog cleared" banner.
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    clearedAtMap['net1:#chan'] = Date.now();
    render(LoadMore);
    await expect.element(page.getByText('Load more backlog…')).not.toBeInTheDocument();
  });

  it('shows the loadMore button without clearedAt (IRCCloud renderLoadMore)', async () => {
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    ircState.messages['net1:#chan'] = [
      { command: 'PRIVMSG', nick: 'alice', text: 'hello', t: Date.now() },
    ];
    render(LoadMore);
    await expect.element(page.getByText('Load more backlog…')).toBeInTheDocument();
  });
});
