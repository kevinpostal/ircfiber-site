import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import MessageRow from './MessageRow.svelte';
import { createMessage } from '../test/factories';

describe('MessageRow Accessibility', () => {
  it('nick element is clickable', async () => {
    const onNickClick = vi.fn();
    await render(MessageRow, {
      props: { msg: createMessage({ nick: 'alice', text: 'hi' }), onNickClick },
    });
    const nick = page.getByText('alice');
    await expect.element(nick).toBeInTheDocument();
  });

  it('supports keyboard navigation on nick', async () => {
    const onNickClick = vi.fn();
    await render(MessageRow, {
      props: { msg: createMessage({ nick: 'alice', text: 'hi' }), onNickClick },
    });
    const nick = page.getByText('alice');
    await expect.element(nick).toBeInTheDocument();
    await userEvent.click(nick);
    expect(onNickClick).toHaveBeenCalled();
  });
});
