/**
 * FilterHorizontal — Django `filter_horizontal` two-pane chooser.
 *
 * Coverage:
 *  1. Options split into Available / Chosen from `selected`.
 *  2. Choose all / Remove all move every visible option.
 *  3. Double-click moves a single option; chosen order is preserved.
 *  4. Filter boxes narrow each pane independently.
 *  5. Locked values cannot be removed (single or Remove all).
 */
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync } from 'svelte';

import FilterHorizontal from './FilterHorizontal.svelte';

const options = [
  { value: 'admin', label: 'admin', hint: 'Full access' },
  { value: 'user', label: 'user', hint: 'Default' },
  { value: 'mod', label: 'mod' },
];

function values(sel: string): string[] {
  return [...document.querySelectorAll<HTMLOptionElement>(`${sel} option`)].map((o) => o.value);
}

describe('FilterHorizontal', () => {
  it('splits options into available and chosen panes', async () => {
    render(FilterHorizontal, { props: { id: 'r', label: 'roles', options, selected: ['user'] } });
    await expect.element(page.getByText('Available roles')).toBeInTheDocument();
    await expect.element(page.getByText('Chosen roles')).toBeInTheDocument();
    expect(values('#r-available')).toEqual(['admin', 'mod']);
    expect(values('#r-chosen')).toEqual(['user']);
  });

  it('Choose all / Remove all move everything', async () => {
    render(FilterHorizontal, { props: { id: 'r', label: 'roles', options, selected: ['user'] } });
    await userEvent.click(page.getByRole('button', { name: 'Choose all' }));
    flushSync();
    expect(values('#r-chosen')).toEqual(['user', 'admin', 'mod']);
    expect(values('#r-available')).toEqual([]);
    await userEvent.click(page.getByRole('button', { name: 'Remove all' }));
    flushSync();
    expect(values('#r-chosen')).toEqual([]);
    expect(values('#r-available')).toEqual(['admin', 'user', 'mod']);
  });

  it('double-click moves one option and keeps chosen order', async () => {
    render(FilterHorizontal, { props: { id: 'r', label: 'roles', options, selected: ['user'] } });
    const adminOpt = document.querySelector<HTMLOptionElement>('#r-available option[value="admin"]')!;
    adminOpt.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    flushSync();
    expect(values('#r-chosen')).toEqual(['user', 'admin']);
    const userOpt = document.querySelector<HTMLOptionElement>('#r-chosen option[value="user"]')!;
    userOpt.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    flushSync();
    expect(values('#r-chosen')).toEqual(['admin']);
    expect(values('#r-available')).toEqual(['user', 'mod']);
  });

  it('filter boxes narrow each pane independently', async () => {
    render(FilterHorizontal, { props: { id: 'r', label: 'roles', options, selected: ['user', 'mod'] } });
    await userEvent.fill(page.getByLabelText('Filter available roles'), 'adm');
    expect(values('#r-available')).toEqual(['admin']);
    await userEvent.fill(page.getByLabelText('Filter chosen roles'), 'mo');
    expect(values('#r-chosen')).toEqual(['mod']);
    // Remove all only removes what is visible after filtering.
    await userEvent.click(page.getByRole('button', { name: 'Remove all' }));
    flushSync();
    await userEvent.fill(page.getByLabelText('Filter chosen roles'), '');
    expect(values('#r-chosen')).toEqual(['user']);
  });

  it('locked values survive Remove all and double-click', async () => {
    render(FilterHorizontal, { props: { id: 'r', label: 'roles', options, selected: ['admin', 'user'], locked: ['admin'] } });
    const adminOpt = document.querySelector<HTMLOptionElement>('#r-chosen option[value="admin"]')!;
    expect(adminOpt.disabled).toBe(true);
    adminOpt.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    flushSync();
    await userEvent.click(page.getByRole('button', { name: 'Remove all' }));
    flushSync();
    expect(values('#r-chosen')).toEqual(['admin']);
    await expect.element(page.getByRole('button', { name: 'Remove all' })).toBeDisabled();
  });
});
