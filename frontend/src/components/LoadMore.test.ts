import { describe, expect, it, beforeEach, vi } from 'vitest';
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

  it('shows button only when clearedAt is set', async () => {
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    clearedAtMap['net1:#chan'] = Date.now();
    render(LoadMore);
    await expect.element(page.getByText('Load more backlog…')).toBeInTheDocument();
  });

  it('hides button when clearedAt is cleared by click', async () => {
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    clearedAtMap['net1:#chan'] = Date.now();
    render(LoadMore);
    await expect.element(page.getByText('Load more backlog…')).toBeInTheDocument();
    const button = page.getByRole('button');
    await userEvent.click(button);
    await expect.element(page.getByText('Load more backlog…')).not.toBeInTheDocument();
  });

  it('hides button when clearedAt is not set, even with messages', async () => {
    ircState.activeBuffer.networkId = 'net1';
    ircState.activeBuffer.bufferName = '#chan';
    ircState.messages['net1:#chan'] = [
      { command: 'PRIVMSG', nick: 'alice', text: 'hello', t: Date.now() },
    ];
    render(LoadMore);
    await expect.element(page.getByText('Load more backlog…')).not.toBeInTheDocument();
  });
});
