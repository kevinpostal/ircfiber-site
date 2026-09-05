import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import Overlay from './Overlay.svelte';
import { ircState } from '../stores/ircStore.svelte';

vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  setMaxEid: vi.fn(),
}));

import { sendRaw } from '/src/stores/wsConnection.svelte.ts';
const sendRawMock = sendRaw as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  ircState.overlay.type = null;
  ircState.overlay.data = null;
  sendRawMock.mockClear();
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
    ircState.overlay.data = {
      networkId: 'net1',
      channel: '#testchan',
      bans: [
        { mask: '*!*@bad.actor', setBy: 'op1', setAt: 1700000000 },
        { mask: '*!*@spammer', setBy: 'op2', setAt: 1700000100 },
      ],
    };
    render(Overlay);
    await expect.element(page.getByRole('heading', { name: /Ban list for/ })).toBeInTheDocument();
    await expect.element(page.getByRole('table')).toBeInTheDocument();
    await expect.element(page.getByText('*!*@bad.actor')).toBeInTheDocument();
    await expect.element(page.getByText('*!*@spammer')).toBeInTheDocument();
  });

  it('ban list shows channel name in heading', async () => {
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = { networkId: 'net1', channel: '#mychannel', bans: [{ mask: '*!*@test', setBy: 'op', setAt: 1700000000 }] };
    render(Overlay);
    await expect.element(page.getByText('#mychannel')).toBeInTheDocument();
  });

  it('ban list shows empty state when no bans', async () => {
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = { networkId: 'net1', channel: '#test', bans: [] };
    render(Overlay);
    await expect.element(page.getByText('No bans in effect.')).toBeInTheDocument();
  });

  it('ban list shows table headers', async () => {
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = { networkId: 'net1', channel: '#test', bans: [{ mask: '*!*@x', setBy: 'op', setAt: 1700000000 }] };
    render(Overlay);
    await expect.element(page.getByText('Ban mask')).toBeInTheDocument();
    await expect.element(page.getByText('Set by')).toBeInTheDocument();
    await expect.element(page.getByText('When')).toBeInTheDocument();
    await expect.element(page.getByText('Remove')).toBeInTheDocument();
  });

  it('ban list shows unban links', async () => {
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = { networkId: 'net1', channel: '#test', bans: [{ mask: '*!*@bad', setBy: 'op', setAt: 1700000000 }] };
    render(Overlay);
    const unbanLink = page.getByTitle('Unban *!*@bad');
    await expect.element(unbanLink).toBeInTheDocument();
  });

  it('ban list shows relative time', async () => {
    const recentTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = { networkId: 'net1', channel: '#test', bans: [{ mask: '*!*@x', setBy: 'op', setAt: recentTime }] };
    render(Overlay);
    await expect.element(page.getByText('1 hour ago')).toBeInTheDocument();
  });

  it('ban list shows set by column', async () => {
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = { networkId: 'net1', channel: '#test', bans: [{ mask: '*!*@x', setBy: 'SomeOp', setAt: 1700000000 }] };
    render(Overlay);
    await expect.element(page.getByText('SomeOp')).toBeInTheDocument();
  });

  it('ban list Done button closes overlay', async () => {
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = { networkId: 'net1', channel: '#test', bans: [] };
    render(Overlay);
    await userEvent.click(page.getByRole('button', { name: 'Done' }));
    expect(ircState.overlay.type).toBeNull();
    expect(ircState.overlay.data).toBeNull();
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
    const { container } = render(Overlay);
    await expect.element(page.getByRole('heading', { name: 'WHOIS: Alice' })).toBeInTheDocument();
    // Light dismiss: the overlay is a native modal <dialog>, so a click on the
    // backdrop region outside the panel is dispatched with the <dialog>
    // element itself as the event target (there is no backdrop div anymore).
    const dialogEl = container.querySelector('dialog') as HTMLDialogElement | null;
    expect(dialogEl).not.toBeNull();
    // A click that originates inside the panel must NOT dismiss.
    const inner = dialogEl!.querySelector('.overlay-content') as HTMLElement;
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ircState.overlay.type).toBe('whois');
    dialogEl!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ircState.overlay.type).toBeNull();
    expect(ircState.overlay.data).toBeNull();
  });

  it('closes overlay on close button click', async () => {
    ircState.overlay.type = 'banlist';
    ircState.overlay.data = { networkId: 'net1', channel: '#testchan', bans: [] };
    render(Overlay);
    await expect.element(page.getByText('No bans in effect.')).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Done' }));
    expect(ircState.overlay.type).toBeNull();
    expect(ircState.overlay.data).toBeNull();
  });

  it('renders set_topic overlay with current topic pre-populated', async () => {
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org:6697',
      bufferName: '#bowlcut',
      currentTopic: "roarie's obsession with gf who dumped him 8 years ago: https://meth.cat/file/177991056266.txt?spoke_obsession | roarie's torrents: http...",
    };
    render(Overlay);
    await expect.element(page.getByText(/Set the topic for #bowlcut \(138 chars\)/)).toBeInTheDocument();
    const textarea = document.querySelector('textarea.prompt') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toContain("roarie's obsession");
  });

  it('sends TOPIC and closes overlay on OK click', async () => {
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org:6697',
      bufferName: '#bowlcut',
      currentTopic: 'old topic',
    };
    render(Overlay);
    const input = page.getByRole('textbox', { name: 'Channel topic' });
    await userEvent.fill(input, 'new topic text');
    await userEvent.click(page.getByRole('button', { name: 'OK' }));
    expect(sendRawMock).toHaveBeenCalledWith('net1', 'TOPIC #bowlcut :new topic text');
    expect(ircState.overlay.type).toBeNull();
  });

  it('set_topic input is a textarea that can hold a very long topic', async () => {
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org:6697',
      bufferName: '#bowlcut',
      currentTopic: 'A'.repeat(500),
    };
    render(Overlay);

    const textarea = page.getByRole('textbox', { name: 'Channel topic' }).element() as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.value).toHaveLength(500);
  });

  it('set_topic input has rows attribute for visible height', async () => {
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org:6697',
      bufferName: '#bowlcut',
      currentTopic: 'short',
    };
    render(Overlay);

    const textarea = page.getByRole('textbox', { name: 'Channel topic' }).element() as HTMLTextAreaElement;
    expect(textarea.rows).toBe(4);
  });

  it('renders formatting toolbar with B/I/U/S/M buttons', async () => {
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1', networkName: 'Net', networkHost: 'h:1',
      bufferName: '#c', currentTopic: '',
    };
    render(Overlay);

    await expect.element(page.getByTitle('Bold (Ctrl+B)')).toBeInTheDocument();
    await expect.element(page.getByTitle('Italic')).toBeInTheDocument();
    await expect.element(page.getByTitle('Underline')).toBeInTheDocument();
    await expect.element(page.getByTitle('Strikethrough')).toBeInTheDocument();
    await expect.element(page.getByTitle('Monospace')).toBeInTheDocument();
    await expect.element(page.getByTitle('Reset formatting')).toBeInTheDocument();
  });

  it('clicking Bold inserts a 0x02 char into the topic', async () => {
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1', networkName: 'Net', networkHost: 'h:1',
      bufferName: '#c', currentTopic: 'hello',
    };
    render(Overlay);

    // Position caret at the start
    const textarea = page.getByRole('textbox', { name: 'Channel topic' }).element() as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 0);
    textarea.focus();

    await userEvent.click(page.getByTitle('Bold (Ctrl+B)'));

    // After clicking, the topic should start with 0x02 (bold)
    expect(textarea.value.charCodeAt(0)).toBe(0x02);
    expect(textarea.value).toContain('hello');
  });

  it('clicking a color swatch inserts the color code into the topic', async () => {
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1', networkName: 'Net', networkHost: 'h:1',
      bufferName: '#c', currentTopic: 'red text',
    };
    render(Overlay);

    // Open the color picker dropdown so the swatches are visible
    const summary = document.querySelector('.fmt-color-picker summary') as HTMLElement;
    summary.click();

    const redSwatch = page.getByTitle('Red');
    await redSwatch.click();

    const textarea = page.getByRole('textbox', { name: 'Channel topic' }).element() as HTMLTextAreaElement;
    // Color code 0x03 + "4" (mIRC red) is inserted at the current caret position
    // (end of the existing text in this test, since no caret positioning was set)
    expect(textarea.value).toContain('red text' + String.fromCharCode(0x03) + '4');
  });

  it('preserves existing IRC color codes when opening the modal', async () => {
    const topicWithColors = String.fromCharCode(0x03) + '4' + 'red' + String.fromCharCode(0x03) + '8' + ' yellow';
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1', networkName: 'Net', networkHost: 'h:1',
      bufferName: '#c', currentTopic: topicWithColors,
    };
    render(Overlay);

    const textarea = page.getByRole('textbox', { name: 'Channel topic' }).element() as HTMLTextAreaElement;
    expect(textarea.value).toBe(topicWithColors);
  });

  it('shows a live preview pane that renders the IRC formatting', async () => {
    const topicWithColors = String.fromCharCode(0x02) + 'bold' + String.fromCharCode(0x0f) + ' normal';
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1', networkName: 'Net', networkHost: 'h:1',
      bufferName: '#c', currentTopic: topicWithColors,
    };
    render(Overlay);

    const preview = document.querySelector('.topic-preview-content');
    expect(preview).toBeTruthy();
    // The bold portion should be wrapped in a <span class="bold"> tag
    expect(preview?.innerHTML).toContain('class="bold"');
    expect(preview?.textContent).toContain('bold');
    expect(preview?.textContent).toContain('normal');
  });

  it('closes set_topic overlay on Cancel click without sending', async () => {
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org:6697',
      bufferName: '#bowlcut',
      currentTopic: 'old topic',
    };
    render(Overlay);
    await userEvent.click(page.getByRole('button', { name: 'Cancel' }));
    expect(sendRawMock).not.toHaveBeenCalled();
    expect(ircState.overlay.type).toBeNull();
  });

  it('sends TOPIC on Ctrl+Enter key in textarea', async () => {
    ircState.overlay.type = 'set_topic';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org:6697',
      bufferName: '#bowlcut',
      currentTopic: 'old topic',
    };
    render(Overlay);
    const input = page.getByRole('textbox', { name: 'Channel topic' });
    await userEvent.fill(input, 'submitted via enter');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(sendRawMock).toHaveBeenCalledWith('net1', 'TOPIC #bowlcut :submitted via enter');
  });

  it('renders invite overlay with network label and channel', async () => {
    ircState.overlay.type = 'invite';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org',
      networkPort: 6697,
      networkTls: 'enabled',
      bufferName: '#ZOD',
    };
    render(Overlay);
    await expect.element(page.getByText(/SuperNETs \(irc\.supernets\.org:6697\)/)).toBeInTheDocument();
    await expect.element(page.getByText(/Invite someone to join #ZOD/)).toBeInTheDocument();
    const input = page.getByPlaceholder('Nickname');
    expect(input).toBeTruthy();
  });

  it('does not show a links and badges link', async () => {
    ircState.overlay.type = 'invite';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org',
      networkPort: 6697,
      networkTls: 'enabled',
      bufferName: '#ZOD',
    };
    render(Overlay);
    expect(document.querySelector('a.badges-link')).toBeNull();
  });

  it('sends INVITE command when OK clicked', async () => {
    ircState.overlay.type = 'invite';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org',
      networkPort: 6697,
      networkTls: 'enabled',
      bufferName: '#ZOD',
    };
    render(Overlay);
    const input = page.getByPlaceholder('Nickname');
    await userEvent.fill(input, 'alice');
    await userEvent.click(page.getByRole('button', { name: 'OK' }));
    expect(sendRawMock).toHaveBeenCalledWith('net1', 'INVITE alice #ZOD');
    expect(ircState.overlay.type).toBeNull();
  });

  it('invite Enter key submits', async () => {
    ircState.overlay.type = 'invite';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org',
      networkPort: 6697,
      networkTls: 'enabled',
      bufferName: '#ZOD',
    };
    render(Overlay);
    const input = page.getByPlaceholder('Nickname');
    await userEvent.fill(input, 'bob');
    await userEvent.keyboard('{Enter}');
    expect(sendRawMock).toHaveBeenCalledWith('net1', 'INVITE bob #ZOD');
  });

  it('invite does not submit on empty nick', async () => {
    ircState.overlay.type = 'invite';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org',
      networkPort: 6697,
      networkTls: 'enabled',
      bufferName: '#ZOD',
    };
    render(Overlay);
    await userEvent.click(page.getByRole('button', { name: 'OK' }));
    expect(sendRawMock).not.toHaveBeenCalled();
    expect(ircState.overlay.type).not.toBeNull();
  });

  it('invite trims whitespace from nick', async () => {
    ircState.overlay.type = 'invite';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org',
      networkPort: 6697,
      networkTls: 'enabled',
      bufferName: '#ZOD',
    };
    render(Overlay);
    const input = page.getByPlaceholder('Nickname');
    await userEvent.fill(input, '   carol   ');
    await userEvent.click(page.getByRole('button', { name: 'OK' }));
    expect(sendRawMock).toHaveBeenCalledWith('net1', 'INVITE carol #ZOD');
  });

  it('invite Cancel closes without sending', async () => {
    ircState.overlay.type = 'invite';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org',
      networkPort: 6697,
      networkTls: 'enabled',
      bufferName: '#ZOD',
    };
    render(Overlay);
    await userEvent.fill(page.getByPlaceholder('Nickname'), 'alice');
    await userEvent.click(page.getByRole('button', { name: 'Cancel' }));
    expect(sendRawMock).not.toHaveBeenCalled();
    expect(ircState.overlay.type).toBeNull();
  });

  it('invite Escape closes without sending', async () => {
    ircState.overlay.type = 'invite';
    ircState.overlay.data = {
      networkId: 'net1',
      networkName: 'SuperNETs',
      networkHost: 'irc.supernets.org',
      networkPort: 6697,
      networkTls: 'enabled',
      bufferName: '#ZOD',
    };
    render(Overlay);
    const input = page.getByPlaceholder('Nickname');
    await userEvent.click(input);
    await userEvent.keyboard('{Escape}');
    expect(sendRawMock).not.toHaveBeenCalled();
    expect(ircState.overlay.type).toBeNull();
  });
});
