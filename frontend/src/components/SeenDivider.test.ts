// The seen divider has two variants. IRCCloud's third one, focusSeen
// ("New messages since you tabbed out"), is deliberately gone: it fired on
// every window switch, even for a single line. If it comes back, this file
// is where the missing label should show up.
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SeenDivider from './SeenDivider.svelte';

describe('SeenDivider', () => {
  it('labels the scrolled-up variant', async () => {
    render(SeenDivider, { props: { type: 'bottom' } });
    await expect.element(page.getByText('New messages since you scrolled up')).toBeInTheDocument();
  });

  it('labels the new-messages variant', async () => {
    render(SeenDivider, { props: { type: 'last' } });
    await expect.element(page.getByText('New messages')).toBeInTheDocument();
  });

  it('never renders a tab-out label', async () => {
    render(SeenDivider, { props: { type: 'last' } });
    await expect.element(page.getByText('New messages')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('tabbed out');
  });
});
