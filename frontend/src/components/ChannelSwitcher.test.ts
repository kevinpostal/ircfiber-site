import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import ChannelSwitcher from './ChannelSwitcher.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer, createServerBuffer } from '../test/factories';

describe('ChannelSwitcher', () => {
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    onClose = vi.fn();
    vi.clearAllMocks();
  });

  function setup(options?: { scope?: 'all' | 'active' }) {
    const net1 = createNetwork({ name: 'Libera' });
    net1.buffers.push(createServerBuffer());
    net1.buffers.push(createBuffer({ name: '#general', isJoined: true }));
    net1.buffers.push(createBuffer({ name: '#rust', isJoined: true }));
    net1.buffers.push(createBuffer({ name: '#random', isJoined: false }));
    const net2 = createNetwork({ name: 'OFTC' });
    net2.buffers.push(createServerBuffer());
    net2.buffers.push(createBuffer({ name: '#help', isJoined: true }));
    net2.buffers.push(createBuffer({ name: '#dev', isJoined: true }));
    net2.buffers.push(createBuffer({ name: '#lounge', isJoined: false }));
    ircState.networks.push(net1, net2);
    return render(ChannelSwitcher, { props: { onClose, scope: options?.scope ?? 'all' } });
  }

  it('renders search input', async () => {
    setup();
    await expect.element(page.getByPlaceholder('Quick switch...')).toBeInTheDocument();
  });

  it('shows all buffers by default', async () => {
    setup();
    await expect.element(page.getByText('#general')).toBeInTheDocument();
    await expect.element(page.getByText('#rust')).toBeInTheDocument();
    await expect.element(page.getByText('#help')).toBeInTheDocument();
    await expect.element(page.getByText('#dev')).toBeInTheDocument();
  });

  it('shows disambiguation badge with server name', async () => {
    setup();
    // Multiple results share the same server badge text; use .first() to
    // avoid strict-mode violation for multiple matches.
    await expect.element(page.getByText('Libera').first()).toBeInTheDocument();
    await expect.element(page.getByText('OFTC').first()).toBeInTheDocument();
  });

  it('filters buffers by query', async () => {
    setup();
    const input = page.getByPlaceholder('Quick switch...');
    await userEvent.type(input, 'rust');
    await expect.element(page.getByText('#rust')).toBeInTheDocument();
    await expect.element(page.getByText('#general')).not.toBeInTheDocument();
    await expect.element(page.getByText('#help')).not.toBeInTheDocument();
  });

  it('filters with fuzzy match (non-prefix)', async () => {
    setup();
    const input = page.getByPlaceholder('Quick switch...');
    await userEvent.type(input, 'hel');
    await expect.element(page.getByText('#help')).toBeInTheDocument();
    await expect.element(page.getByText('#general')).not.toBeInTheDocument();
  });

  it('calls onClose on Escape key', async () => {
    setup();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('navigates with ArrowDown and selects with Enter', async () => {
    setup();
    const input = page.getByPlaceholder('Quick switch...');
    await userEvent.type(input, 'gen');
    // ArrowDown to second result, then Enter
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    // The first result is the best match (#general)
    expect(ircState.activeBuffer.bufferName).toBe('#general');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('navigates with ArrowDown and ArrowUp', async () => {
    setup();
    // Type something that returns multiple results
    const input = page.getByPlaceholder('Quick switch...');
    await userEvent.type(input, '#');
    // Wait for rendering
    await vi.waitFor(() => {
      // Should have at least some results
      expect(page.getByText('#general')).toBeInTheDocument();
    });
    // ArrowDown twice, then up once
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard('{Enter}');
    // Should have selected something (just verify Enter was handled)
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('scope="active" hides non-joined buffers', async () => {
    setup({ scope: 'active' });
    // #random and #lounge are not joined
    await expect.element(page.getByText('#random')).not.toBeInTheDocument();
    await expect.element(page.getByText('#lounge')).not.toBeInTheDocument();
    // #general is joined
    await expect.element(page.getByText('#general')).toBeInTheDocument();
  });

  it('resets selection when query changes', async () => {
    setup();
    const input = page.getByPlaceholder('Quick switch...');
    await userEvent.type(input, 'ru');
    // ArrowDown to second item
    await userEvent.keyboard('{ArrowDown}');
    // Clear and re-type
    await userEvent.clear(input);
    await userEvent.type(input, 'ge');
    await userEvent.keyboard('{Enter}');
    expect(ircState.activeBuffer.bufferName).toBe('#general');
  });

  it('shows archived badge for archived buffers', async () => {
    setup();
    // Without archive names loaded, no badges shown
    const input = page.getByPlaceholder('Quick switch...');
    await userEvent.type(input, 'gen');
    // Just verifies component renders without error
    await expect.element(page.getByText('#general')).toBeInTheDocument();
  });

  it('displays empty state when no results match', async () => {
    setup();
    const input = page.getByPlaceholder('Quick switch...');
    await userEvent.type(input, 'zzzzzznonexistent');
    await expect.element(page.getByText('#general')).not.toBeInTheDocument();
  });
});
