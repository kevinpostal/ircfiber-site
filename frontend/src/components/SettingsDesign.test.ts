import { describe, expect, it, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import SettingsDesign from './SettingsDesign.svelte';
import { globalPrefs } from '../stores/preferences.svelte';

describe('SettingsDesign', () => {
  beforeEach(() => {
    globalPrefs.customCSS = '';
  });

  it('renders the custom CSS textarea', async () => {
    render(SettingsDesign);
    const textarea = page.getByRole('textbox', { name: /custom css/i });
    await expect.element(textarea).toBeInTheDocument();
  });

  it('renders the placeholder text', async () => {
    const { container } = render(SettingsDesign);
    const textarea = container.querySelector('#custom-css') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea?.placeholder).toContain('row.messageRow');
  });

  it('shows syntax error for invalid CSS', async () => {
    const { container } = render(SettingsDesign);
    const textarea = container.querySelector('#custom-css') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    // Set invalid CSS (no valid rules can be parsed)
    textarea!.value = '{{{broken';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));

    // Wait for $effect to run
    await new Promise(r => setTimeout(r, 0));

    const status = container.querySelector('.custom-css-status');
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain('Invalid CSS');
    expect(status!.classList.contains('error')).toBe(true);
  });

  it('shows applied status for valid CSS', async () => {
    const { container } = render(SettingsDesign);
    const textarea = container.querySelector('#custom-css') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    // Set valid CSS
    textarea!.value = '.foo { color: red; }';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));

    // Wait for $effect to run
    await new Promise(r => setTimeout(r, 0));

    const status = container.querySelector('.custom-css-status');
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain('Applied');
    expect(status!.classList.contains('success')).toBe(true);
  });

  it('shows reset button when valid CSS is present', async () => {
    const { container } = render(SettingsDesign);
    const textarea = container.querySelector('#custom-css') as HTMLTextAreaElement;

    // Set valid CSS
    textarea!.value = '.foo { color: red; }';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    const resetBtn = container.querySelector('.settings-btn--secondary');
    expect(resetBtn).toBeTruthy();
  });

  it('hides reset button when CSS is empty', async () => {
    const { container } = render(SettingsDesign);
    const resetBtn = container.querySelector('.settings-btn--secondary');
    expect(resetBtn).toBeFalsy();
  });

  it('resets CSS when reset button clicked', async () => {
    const { container } = render(SettingsDesign);
    const textarea = container.querySelector('#custom-css') as HTMLTextAreaElement;

    // Set valid CSS
    textarea!.value = '.foo { color: red; }';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    // Click reset
    const resetBtn = container.querySelector('.settings-btn--secondary') as HTMLButtonElement;
    expect(resetBtn).toBeTruthy();
    resetBtn!.click();
    await new Promise(r => setTimeout(r, 0));

    // Textarea should be empty
    expect(textarea!.value).toBe('');

    // globalPrefs should be cleared
    expect(globalPrefs.customCSS).toBe('');
  });
});
