/**
 * LogRow -- single row in the logs table.
 *
 * Covers the four core contracts from the task handoff:
 *   1. Renders timestamp, severity chip, service, body (truncated)
 *   2. Severity chip class differs per level
 *   3. traceId renders as link; absent renders `--`
 *   4. Clicking calls onToggle(id, rect)
 *
 * Pattern follows the existing FilterCheatsheet / LogsToolbar tests:
 * vitest-browser-svelte `render`, `page` + `userEvent` from
 * vitest/browser, real DOM. We never mock the store -- LogRow is
 * pure presentation and receives the row + onToggle callback as props.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import LogRow from './LogRow.svelte';
import type { LogRow as LogRowType } from '../../stores/logsStore';

function makeRow(overrides: Partial<LogRowType> = {}): LogRowType {
  return {
    timestamp: 1_700_000_000_000,
    severity: 'INFO',
    service: 'irc-fiber-gateway',
    body: 'hello world',
    traceId: 'abc123def',
    attributes: {},
    rawJson: {
      timestamp: 1_700_000_000_000,
      severity_text: 'INFO',
      service_name: 'irc-fiber-gateway',
      body: 'hello world',
      trace_id: 'abc123def',
    },
    ...overrides,
  };
}

describe('LogRow -- default render', () => {
  it('renders timestamp, severity chip, service, and body', async () => {
    const row = makeRow();
    render(LogRow, { props: { row, onToggle: vi.fn() } });
    const root = page.getByTestId('log-row');
    await expect.element(root).toBeInTheDocument();

    // Timestamp: HH:MM:SS.mmm in local time.
    const ts = page.getByTestId('log-row-timestamp');
    await expect.element(ts).toBeInTheDocument();
    expect(ts.element().textContent).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);

    // Severity chip carries the severity string.
    const sev = page.getByTestId('log-row-severity');
    await expect.element(sev).toBeInTheDocument();
    expect(sev.element().textContent?.trim()).toBe('INFO');
    expect(sev.element().getAttribute('data-severity')).toBe('INFO');

    // Service + body text present.
    expect(page.getByTestId('log-row-service').element().textContent).toBe('irc-fiber-gateway');
    expect(page.getByTestId('log-row-body').element().textContent).toBe('hello world');
  });

  it('truncates body to 200 chars + ellipsis when body.length > 200', async () => {
    const longBody = 'x'.repeat(250);
    const row = makeRow({ body: longBody });
    render(LogRow, { props: { row, onToggle: vi.fn() } });
    const bodyEl = page.getByTestId('log-row-body').element() as HTMLElement;
    // 199 x's + ellipsis = 200 visible chars.
    expect(bodyEl.textContent).toBe('x'.repeat(199) + '\u2026');
    // The full body is preserved in the title attribute for hover-preview.
    expect(bodyEl.getAttribute('title')).toBe(longBody);
  });

  it('renders a short body verbatim (no ellipsis when length <= 200)', async () => {
    const row = makeRow({ body: 'short body' });
    render(LogRow, { props: { row, onToggle: vi.fn() } });
    const bodyEl = page.getByTestId('log-row-body').element() as HTMLElement;
    expect(bodyEl.textContent).toBe('short body');
  });
});

describe('LogRow -- severity chip', () => {
  // Each severity gets a distinct chip class so the operator can scan
  // a 10k-row table and pick out errors at a glance.
  const SEVERITIES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

  for (const sev of SEVERITIES) {
    it(`renders a chip with distinct classes for ${sev}`, async () => {
      const row = makeRow({ severity: sev });
      render(LogRow, { props: { row, onToggle: vi.fn() } });
      const chip = page.getByTestId('log-row-severity').element() as HTMLElement;
      const cls = chip.className;
      // Every chip gets the base utility set + a per-severity color combo.
      expect(cls).toContain('rounded');
      expect(cls).toContain('font-semibold');
      // Sanity: each severity carries at least one bg-* and one text-*.
      expect(cls).toMatch(/\bbg-/);
      expect(cls).toMatch(/\btext-/);
      expect(chip.getAttribute('data-severity')).toBe(sev);
    });
  }

  it('gives each of the five severities a different className', async () => {
    // Capture the chip class for each severity and assert the set has
    // size 5 -- no two severities share an identical rendering.
    const seen = new Set<string>();
    for (const sev of SEVERITIES) {
      const row = makeRow({ severity: sev });
      const { unmount } = render(LogRow, { props: { row, onToggle: vi.fn() } });
      seen.add(page.getByTestId('log-row-severity').element().className);
      unmount();
    }
    expect(seen.size).toBe(SEVERITIES.length);
  });
});

describe('LogRow -- trace_id', () => {
  it('renders traceId as a link to the tailnet SigNoz logs page when present', async () => {
    const row = makeRow({ traceId: 'abc123def' });
    render(LogRow, { props: { row, onToggle: vi.fn() } });
    const link = page.getByTestId('log-row-trace-link').element() as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.href).toContain('/logs');
    // The query string must carry the trace_id filter.
    expect(link.href).toContain('trace_id');
    expect(link.href).toContain('abc123def');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    // The link text is the trace id itself.
    expect(link.textContent?.trim()).toBe('abc123def');
  });

  it('renders "--" when traceId is absent', async () => {
    const row = makeRow({ traceId: undefined });
    render(LogRow, { props: { row, onToggle: vi.fn() } });
    // No link in the DOM.
    expect(document.querySelector('[data-testid="log-row-trace-link"]')).toBeNull();
    const placeholder = page.getByTestId('log-row-trace-placeholder').element() as HTMLElement;
    expect(placeholder.textContent?.trim()).toBe('--');
  });
});

describe('LogRow -- click handling', () => {
  it('calls onToggle with (rowId, rect) when the row is clicked', async () => {
    const row = makeRow({ traceId: 'trace-xyz' });
    const onToggle = vi.fn();
    render(LogRow, { props: { row, onToggle } });
    const rowEl = page.getByTestId('log-row').element() as HTMLElement;
    await userEvent.click(rowEl);
    expect(onToggle).toHaveBeenCalledTimes(1);
    const [id, rect] = onToggle.mock.calls[0]!;
    // traceId wins, so the id should be the trace id.
    expect(id).toBe('trace-xyz');
    expect(rect).toBeInstanceOf(DOMRect);
    // The rect should match the row's actual bounding box.
    const expected = rowEl.getBoundingClientRect();
    expect(rect.left).toBeCloseTo(expected.left, 1);
    expect(rect.top).toBeCloseTo(expected.top, 1);
  });

  it('uses a synthesized id when traceId is absent', async () => {
    const row = makeRow({ traceId: undefined, timestamp: 42, service: 'svc', body: 'hello' });
    const onToggle = vi.fn();
    render(LogRow, { props: { row, onToggle } });
    await userEvent.click(page.getByTestId('log-row').element());
    expect(onToggle).toHaveBeenCalledTimes(1);
    const [id] = onToggle.mock.calls[0]!;
    expect(id).toBe('42:svc:hello');
  });

  it('does NOT call onToggle when the trace link is clicked (stopPropagation)', async () => {
    const row = makeRow({ traceId: 'abc' });
    const onToggle = vi.fn();
    render(LogRow, { props: { row, onToggle } });
    const link = page.getByTestId('log-row-trace-link').element() as HTMLAnchorElement;
    // userEvent.click fires a real click; the link's stopPropagation
    // should prevent the row's onclick from running.
    await userEvent.click(link);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('Enter / Space on the focused row also calls onToggle', async () => {
    const row = makeRow();
    const onToggle = vi.fn();
    render(LogRow, { props: { row, onToggle } });
    const rowEl = page.getByTestId('log-row').element() as HTMLElement;
    rowEl.focus();
    await userEvent.keyboard('{Enter}');
    expect(onToggle).toHaveBeenCalledTimes(1);
    onToggle.mockClear();
    rowEl.focus();
    await userEvent.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});