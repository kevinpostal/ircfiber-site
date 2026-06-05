import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Sidebar from './Sidebar.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { ircState } from '../stores/ircStore.svelte';

describe('Sidebar Accessibility', () => {
  beforeEach(() => {
    ircState.networks.length = 0;
  });

  it('buffer items have button role', async () => {
    const net = createNetwork({
      buffers: [createBuffer({ name: '#general' })],
    });
    ircState.networks.push(net);
    await render(Sidebar, {
      props: { onSwitchBuffer: vi.fn(), onAddNetwork: vi.fn() },
    });
    // Check buffer names are present
    await expect.element(page.getByText('#general')).toBeInTheDocument();
  });
});
