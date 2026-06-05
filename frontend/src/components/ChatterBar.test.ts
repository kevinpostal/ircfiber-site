import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import ChatterBar from './ChatterBar.svelte';

describe('ChatterBar', () => {
  it('renders up arrow for above position', async () => {
    render(ChatterBar, { props: { position: 'above', count: 5, onClick: vi.fn() } });
    await expect.element(page.getByText('↑')).toBeInTheDocument();
  });

  it('renders down arrow for below position', async () => {
    render(ChatterBar, { props: { position: 'below', count: 5, onClick: vi.fn() } });
    await expect.element(page.getByText('↓')).toBeInTheDocument();
  });

  it('renders count badge', async () => {
    render(ChatterBar, { props: { position: 'above', count: 42, onClick: vi.fn() } });
    await expect.element(page.getByText('42')).toBeInTheDocument();
  });

  it('renders "message" singular when count is 1', async () => {
    render(ChatterBar, { props: { position: 'above', count: 1, onClick: vi.fn() } });
    await expect.element(page.getByText('1 unread message')).toBeInTheDocument();
  });

  it('renders "messages" plural when count is not 1', async () => {
    render(ChatterBar, { props: { position: 'below', count: 5, onClick: vi.fn() } });
    await expect.element(page.getByText('5 unread messages')).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    render(ChatterBar, { props: { position: 'above', count: 3, onClick } });
    const button = page.getByRole('button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
