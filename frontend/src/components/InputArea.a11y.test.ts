import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import InputArea from './InputArea.svelte';

describe('InputArea Accessibility', () => {
  it('textarea has correct role', async () => {
    await render(InputArea);
    const input = page.getByRole('textbox');
    await expect.element(input).toBeInTheDocument();
  });
});
