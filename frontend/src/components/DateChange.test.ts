import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import DateChange from './DateChange.svelte';

describe('DateChange', () => {
  it('renders formatted date', async () => {
    render(DateChange, { props: { date: '2024-01-15' } });
    await expect.element(page.getByText('Monday, January 15th, 2024')).toBeInTheDocument();
  });

  it('renders relative time indicator', async () => {
    render(DateChange, { props: { date: '2020-06-01' } });
    await expect.element(page.getByText(/ago/)).toBeInTheDocument();
  });
});
