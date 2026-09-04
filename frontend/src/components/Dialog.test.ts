import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import Dialog from './Dialog.svelte';

function openDialog(props: { onClose: () => void; dismissable?: boolean }) {
  render(Dialog, { props: { open: true, label: 'Test dialog', ...props } });
  const el = document.querySelector('dialog');
  if (!el) throw new Error('dialog did not render');
  return el as HTMLDialogElement;
}

describe('Dialog dismiss behavior', () => {
  it('closes on backdrop click by default', async () => {
    const onClose = vi.fn();
    const el = openDialog({ onClose });
    await expect.element(page.getByRole('dialog', { name: 'Test dialog' })).toBeInTheDocument();
    // A real backdrop click targets the <dialog> element itself.
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honors cancel (Escape) by default', async () => {
    const onClose = vi.fn();
    const el = openDialog({ onClose });
    await expect.element(page.getByRole('dialog', { name: 'Test dialog' })).toBeInTheDocument();
    el.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores backdrop clicks when dismissable={false}', async () => {
    const onClose = vi.fn();
    const el = openDialog({ onClose, dismissable: false });
    await expect.element(page.getByRole('dialog', { name: 'Test dialog' })).toBeInTheDocument();
    // closedby=none is what stops the UA's own Esc/backdrop handling.
    expect(el.getAttribute('closedby')).toBe('none');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores cancel (Escape) when dismissable={false}', async () => {
    const onClose = vi.fn();
    const el = openDialog({ onClose, dismissable: false });
    await expect.element(page.getByRole('dialog', { name: 'Test dialog' })).toBeInTheDocument();
    el.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes via the × button when dismissable={false}', async () => {
    const onClose = vi.fn();
    openDialog({ onClose, dismissable: false });
    await expect.element(page.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    // Dispatched (not pointer) click: the bare test render never settles
    // for Playwright actionability, but the handler path is identical.
    const btn = document.querySelector('button.overlay-close');
    if (!btn) throw new Error('× button did not render');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });
});
