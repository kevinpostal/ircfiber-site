import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import AccountMenu from './AccountMenu.svelte';
import { ircState } from '../stores/ircStore.svelte';

/**
 * AccountMenu — the "Account Settings" gear in the sidebar.
 *
 * The popup used to have no dismissal at all: once opened it stayed until
 * you hit the gear again or picked an item. Every other popup in the app
 * (ChannelContextMenu, ServerLogContextMenu) closes on an outside click
 * and on Escape; this one now matches.
 */
function open(): HTMLElement {
  render(AccountMenu, { props: { onAddNetwork: vi.fn() } });
  const gear = document.querySelector('.accountMenu__button') as HTMLElement;
  gear.click();
  return gear;
}

beforeEach(() => {
  ircState.showSettings = false;
  ircState.showShortcuts = false;
  document.body.querySelectorAll('.outside-probe').forEach((e) => e.remove());
});

describe('AccountMenu dismissal', () => {
  it('opens on the gear and reports it through aria-expanded', async () => {
    const gear = open();
    await tick();
    expect(document.querySelector('#accountMenu')).not.toBeNull();
    expect(gear.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes on a click anywhere off the menu', async () => {
    open();
    await tick();
    expect(document.querySelector('#accountMenu')).not.toBeNull();

    const elsewhere = document.createElement('div');
    elsewhere.className = 'outside-probe';
    document.body.appendChild(elsewhere);
    elsewhere.click();
    await tick();

    expect(document.querySelector('#accountMenu')).toBeNull();
  });

  it('stays open when the click lands inside the menu', async () => {
    open();
    await tick();
    const info = document.querySelector('.accountMenu__info') as HTMLElement;
    info.click();
    await tick();
    // Clicking the username/email chrome must not dismiss — only real
    // items (which navigate) and outside clicks do.
    expect(document.querySelector('#accountMenu')).not.toBeNull();
  });

  it('closes on Escape', async () => {
    open();
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(document.querySelector('#accountMenu')).toBeNull();
  });

  it('does not reopen when the gear itself is clicked to close', async () => {
    const gear = open();
    await tick();
    // The gear's own handler toggles. If the document listener also fired
    // for it, the menu would close and instantly reopen (or never close).
    gear.click();
    await tick();
    expect(document.querySelector('#accountMenu')).toBeNull();
    expect(gear.getAttribute('aria-expanded')).toBe('false');
  });

  it('stops listening once closed', async () => {
    const spy = vi.spyOn(document, 'removeEventListener');
    const gear = open();
    await tick();
    gear.click();
    await tick();
    const removed = spy.mock.calls.map((c) => c[0]);
    expect(removed).toContain('click');
    expect(removed).toContain('keydown');
    spy.mockRestore();
  });
});
