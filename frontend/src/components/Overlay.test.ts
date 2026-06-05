import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import Overlay from './Overlay.svelte';
import { ircState } from '../stores/ircStore.svelte';

beforeEach(() => {
  ircState.overlay.type = null;
  ircState.overlay.data = null;
});

describe('Overlay', () => {
  it('renders WHOIS data when overlay.type === whois', async () => {
    ircState.overlay.type = 'whois';
    ircState.overlay.data = {
      nick: 'Alice',
      user: 'alice',
      host: 'example.com',
      realname: 'Alice Smith',
      server: 'irc.libera.chat',
      serverInfo: 'Libera Chat',
      channels: ['#chan1', '#chan2'],
      idle: 0,
      signon: 0,
      account: '',
      secure: false,
      away: '',
    };
    render(Overlay);
    await expect.element(page.getByRole('heading', { name: 'WHOIS: Alice' })).toBeInTheDocument();
    await expect.element(page.getByText('alice@example.com')).toBeInTheDocument();
    await expect.element(page.getByText('Alice Smith')).toBeInTheDocument();
    await expect.element(page.getByText('#chan1 #chan2')).toBeInTheDocument();
  });

  it('renders ban list table when overlay.type === banlist', async () => {
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = [
      { mask: '*!*@bad.actor', setBy: 'op1', setAt: 1700000000 },
      { mask: '*!*@spammer', setBy: 'op2', setAt: 1700000100 },
    ];
    render(Overlay);
    await expect.element(page.getByRole('heading', { name: 'Ban List (2)' })).toBeInTheDocument();
    await expect.element(page.getByRole('table')).toBeInTheDocument();
    await expect.element(page.getByText('*!*@bad.actor')).toBeInTheDocument();
    await expect.element(page.getByText('*!*@spammer')).toBeInTheDocument();
  });

  it('closes overlay on backdrop click', async () => {
    ircState.overlay.type = 'whois';
    ircState.overlay.data = {
      nick: 'Alice',
      user: 'alice',
      host: 'example.com',
      realname: '',
      server: '',
      serverInfo: '',
      channels: [],
      idle: 0,
      signon: 0,
      account: '',
      secure: false,
      away: '',
    };
    render(Overlay);
    await expect.element(page.getByRole('heading', { name: 'WHOIS: Alice' })).toBeInTheDocument();
    const backdrop = document.querySelector('.overlay-backdrop') as HTMLElement | null;
    backdrop?.click();
    expect(ircState.overlay.type).toBeNull();
    expect(ircState.overlay.data).toBeNull();
  });

  it('closes overlay on close button click', async () => {
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = [];
    render(Overlay);
    await expect.element(page.getByRole('heading', { name: 'Ban List (0)' })).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Close' }));
    expect(ircState.overlay.type).toBeNull();
    expect(ircState.overlay.data).toBeNull();
  });
});
