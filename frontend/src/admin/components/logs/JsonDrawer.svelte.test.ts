/**
 * JsonDrawer -- overlay expand UI for a single log row's raw JSON.
 *
 * Covers:
 *   10. row === null -> drawer and backdrop are not in DOM
 *   11. With a row, drawer renders + JSON content has key highlighting
 *   12. Click on backdrop closes (calls onClose)
 *   13. Pressing Escape closes
 *   14. Clicking the X button closes
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import JsonDrawer from './JsonDrawer.svelte';
import type { LogRow as LogRowType } from '../../stores/logsStore';

function makeRow(): LogRowType {
  return {
    timestamp: 1_700_000_000_000,
    severity: 'INFO',
    service: 'irc-fiber-gateway',
    body: 'hello',
    traceId: 'trace-xyz',
    attributes: {},
    rawJson: {
      timestamp: 1_700_000_000_000,
      severity_text: 'INFO',
      service_name: 'irc-fiber-gateway',
      body: 'hello',
      trace_id: 'trace-xyz',
    },
  };
}

describe('JsonDrawer -- closed state', () => {
  it('renders nothing when row === null', async () => {
    render(JsonDrawer, {
      props: { row: null, anchorRect: null, onClose: vi.fn() },
    });
    // No dialog, no backdrop, no X button.
    expect(document.querySelector('[data-testid="json-drawer"]')).toBeNull();
    expect(document.querySelector('[data-testid="json-drawer-backdrop"]')).toBeNull();
    expect(document.querySelector('[data-testid="json-drawer-close"]')).toBeNull();
  });

  it('ignores Escape when closed', async () => {
    const onClose = vi.fn();
    render(JsonDrawer, {
      props: { row: null, anchorRect: null, onClose },
    });
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('JsonDrawer -- open state', () => {
  it('renders the dialog and backdrop when row is provided', async () => {
    const row = makeRow();
    render(JsonDrawer, {
      props: { row, anchorRect: null, onClose: vi.fn() },
    });
    const dialog = page.getByTestId('json-drawer');
    await expect.element(dialog).toBeInTheDocument();
    expect(dialog.element().getAttribute('role')).toBe('dialog');
    expect(dialog.element().getAttribute('aria-modal')).toBe('true');
    await expect.element(page.getByTestId('json-drawer-backdrop')).toBeInTheDocument();
    await expect.element(page.getByTestId('json-drawer-close')).toBeInTheDocument();
  });

  it('renders the pretty-printed JSON with key highlighting', async () => {
    const row = makeRow();
    render(JsonDrawer, {
      props: { row, anchorRect: null, onClose: vi.fn() },
    });
    const pre = page.getByTestId('json-drawer-pre').element() as HTMLElement;
    // The JSON content is rendered via {@html}, so the actual spans are
    // in the DOM (not escaped back to text).
    const spans = pre.querySelectorAll('span');
    expect(spans.length).toBeGreaterThan(0);
    // At least one span wraps a known key. Our makeRow has a
    // "timestamp" field, so that span must be present.
    const timestampSpan = Array.from(spans).find(
      (s) => s.textContent === '"timestamp"',
    );
    expect(timestampSpan).toBeTruthy();
    // And the value is right next to it, so the whole field is visible.
    expect(pre.textContent).toContain('"timestamp"');
    expect(pre.textContent).toContain('1_700_000_000_000'.replace(/_/g, ''));
  });

  it('shows the SigNoz deep link in the footer', async () => {
    const row = makeRow();
    render(JsonDrawer, {
      props: { row, anchorRect: null, onClose: vi.fn() },
    });
    const link = page.getByTestId('json-drawer-signoz-link').element() as HTMLAnchorElement;
    expect(link.href).toContain('/logs');
    expect(link.href).toContain('trace-xyz');
    expect(link.target).toBe('_blank');
  });
});

describe('JsonDrawer -- close handlers', () => {
  it('clicking the backdrop calls onClose', async () => {
    const onClose = vi.fn();
    render(JsonDrawer, {
      props: { row: makeRow(), anchorRect: null, onClose },
    });
    await expect.element(page.getByTestId('json-drawer-backdrop')).toBeInTheDocument();
    const backdrop = page
      .getByTestId('json-drawer-backdrop')
      .element() as HTMLElement;
    backdrop.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape calls onClose', async () => {
    const onClose = vi.fn();
    render(JsonDrawer, {
      props: { row: makeRow(), anchorRect: null, onClose },
    });
    // Focus the dialog so the keydown has a real target.
    page.getByTestId('json-drawer').element().focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the X button calls onClose', async () => {
    const onClose = vi.fn();
    render(JsonDrawer, {
      props: { row: makeRow(), anchorRect: null, onClose },
    });
    // The X button is inside a fixed-positioned dialog; we use the
    // raw HTMLElement.click() path (same approach FilterCheatsheet
    // uses for its Close button) so the test exercises the real
    // onclick handler without depending on userEvent's pointer
    // choreography, which can race with focus management in overlays.
    const closeBtn = page
      .getByTestId('json-drawer-close')
      .element() as HTMLButtonElement;
    closeBtn.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});