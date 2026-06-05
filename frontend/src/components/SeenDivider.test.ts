import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SeenDivider from './SeenDivider.svelte';
import { ircState } from '../stores/ircStore.svelte';

describe('SeenDivider', () => {
  const originalFocusLost = ircState.focusLost;

  beforeEach(() => {
    ircState.focusLost = false;
  });

  afterEach(() => {
    ircState.focusLost = originalFocusLost;
  });

  it('renders "New messages" when focusLost is false', async () => {
    ircState.focusLost = false;
    render(SeenDivider);
    await expect.element(page.getByText('New messages')).toBeInTheDocument();
  });

  it('renders "New messages since you tabbed out" when focusLost is true', async () => {
    ircState.focusLost = true;
    render(SeenDivider);
    await expect.element(page.getByText('New messages since you tabbed out')).toBeInTheDocument();
  });
});
