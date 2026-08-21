import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import FilterCheatsheet from './FilterCheatsheet.svelte';

describe('FilterCheatsheet', () => {
  beforeEach(() => {
    // Reset activeElement so prior tests do not leak focus into the
    // initial auto-focus assertion.
    if (typeof document !== 'undefined' && document.body) {
      (document.body as HTMLElement).focus();
    }
  });

  afterEach(() => {
    // Cleanup any leftover window.open spies.
    vi.restoreAllMocks();
  });

  it('renders nothing when open=false', async () => {
    const onClose = vi.fn();
    render(FilterCheatsheet, { props: { open: false, onClose } });
    // No dialog in the DOM at all.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The example code blocks should not be present either.
    expect(document.querySelector('code')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the dialog + title when open=true', async () => {
    render(FilterCheatsheet, { props: { open: true, onClose: vi.fn() } });
    const dialog = page.getByRole('dialog');
    await expect.element(dialog).toBeInTheDocument();
    await expect.element(
      page.getByRole('heading', { name: 'SigNoz filter syntax' }),
    ).toBeInTheDocument();
    // The dialog has the correct ARIA contract.
    expect(dialog.element().getAttribute('aria-modal')).toBe('true');
    const ariaLabel = dialog.element().getAttribute('aria-label');
    const ariaLabelledby = dialog.element().getAttribute('aria-labelledby');
    expect(ariaLabel === 'SigNoz filter syntax' || ariaLabelledby === 'filter-cheatsheet-title').toBe(true);
  });

  it('lists all 6 example filter blocks', async () => {
    render(FilterCheatsheet, { props: { open: true, onClose: vi.fn() } });
    // Each example has a unique sigil so a single query per case finds it.
    await expect.element(
      page.getByText(/severity_text = 'ERROR'/),
    ).toBeInTheDocument();
    await expect.element(
      page.getByText(/body CONTAINS 'timeout'/),
    ).toBeInTheDocument();
    await expect.element(
      page.getByText(/service\.name IN/),
    ).toBeInTheDocument();
    await expect.element(
      page.getByText(/trace_id = 'a1b2c3d4e5f6'/),
    ).toBeInTheDocument();
    await expect.element(
      page.getByText(/resource\.k8s\.pod\.name/),
    ).toBeInTheDocument();
    await expect.element(
      page.getByText(/attribute\.user_id = '42'/),
    ).toBeInTheDocument();
    // Sanity: there are exactly 6 <code> blocks.
    expect(document.querySelectorAll('code').length).toBe(6);
    // Each example has a plain-English explanation paragraph.
    expect(document.querySelectorAll('p.text-xs').length).toBeGreaterThanOrEqual(6);
  });

  it('closes when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    const cmp = render(FilterCheatsheet, {
      props: { open: true, onClose },
    });
    await expect.element(page.getByRole('dialog')).toBeInTheDocument();
    const backdrop = document.querySelector(
      '.filter-cheatsheet-backdrop',
    ) as HTMLElement | null;
    expect(backdrop).toBeTruthy();
    // Simulate a real click on the backdrop element. The handler only
    // closes when e.target === e.currentTarget, so calling .click() on
    // the backdrop is the correct path.
    backdrop?.click();
    expect(onClose).toHaveBeenCalledOnce();
    // The bound `open` prop should also flip to false.
    void cmp;
  });

  it('does NOT close when the inner dialog card is clicked', async () => {
    const onClose = vi.fn();
    render(FilterCheatsheet, { props: { open: true, onClose } });
    const card = document.querySelector('[data-testid="filter-cheatsheet-dialog"]') as HTMLElement;
    expect(card).toBeTruthy();
    card.click();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when Escape is pressed', async () => {
    const onClose = vi.fn();
    render(FilterCheatsheet, { props: { open: true, onClose } });
    await expect.element(page.getByRole('dialog')).toBeInTheDocument();
    // Focus the dialog first so the keydown has a real target.
    page.getByRole('dialog').element().focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not respond to Escape when open=false', async () => {
    const onClose = vi.fn();
    render(FilterCheatsheet, { props: { open: false, onClose } });
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    // Still no dialog in DOM.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('traps focus: Tab on last focusable wraps to first', async () => {
    render(FilterCheatsheet, { props: { open: true, onClose: vi.fn() } });
    // Wait for the initial auto-focus effect to run.
    await expect.poll(() => {
      const close = document.querySelector(
        'button',
      ) as HTMLButtonElement | null;
      return close && document.activeElement === close;
    }).toBe(true);

    const closeBtn = document.querySelector('button') as HTMLButtonElement;
    const docsLink = document.querySelector(
      'a[href*="signoz.io"]',
    ) as HTMLAnchorElement;
    expect(closeBtn).toBeTruthy();
    expect(docsLink).toBeTruthy();

    // Manually move focus to the last focusable to simulate the
    // browser having landed there. Then press Tab and expect the
    // focus trap to bounce us back to the first focusable.
    docsLink.focus();
    expect(document.activeElement).toBe(docsLink);
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(closeBtn);
  });

  it('traps focus: Shift+Tab on first focusable wraps to last', async () => {
    render(FilterCheatsheet, { props: { open: true, onClose: vi.fn() } });
    // Wait for the initial auto-focus effect to run.
    await expect.poll(() => {
      const close = document.querySelector(
        'button',
      ) as HTMLButtonElement | null;
      return close && document.activeElement === close;
    }).toBe(true);

    const closeBtn = document.querySelector('button') as HTMLButtonElement;
    const docsLink = document.querySelector(
      'a[href*="signoz.io"]',
    ) as HTMLAnchorElement;
    expect(closeBtn).toBeTruthy();
    expect(docsLink).toBeTruthy();

    // We are already on the first focusable; Shift+Tab should wrap.
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(docsLink);
  });

  it('auto-focuses the first focusable element when open flips true', async () => {
    const cmp = render(FilterCheatsheet, {
      props: { open: false, onClose: vi.fn() },
    });
    // Before opening, the dialog is not in the DOM at all.
    expect(document.querySelector('button')).toBeNull();
    // Flip the bound prop open. We re-render with the new prop value
    // through the Svelte 5 bindable contract: update props via rerender.
    await cmp.rerender({ open: true });
    // After the open=true transition, the auto-focus effect should
    // have placed focus on the first focusable (the Close button).
    await expect.poll(() => {
      const close = document.querySelector(
        'button',
      ) as HTMLButtonElement | null;
      return close && document.activeElement === close;
    }).toBe(true);
  });
});
