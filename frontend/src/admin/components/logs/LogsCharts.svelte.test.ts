/**
 * LogsCharts -- chart strip over loaded rows.
 *
 * Seeds the real logsStore with rows (no fetch: global fetch is stubbed
 * with a never-settling promise so the click-triggered debounced
 * refetch cannot touch the network or flip the store mid-test), then
 * asserts the three panels render and that legend/service clicks
 * toggle the store filters.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import { get } from 'svelte/store';

import LogsCharts from './LogsCharts.svelte';
import * as store from '../../stores/logsStore';
import type { LogRow } from '../../stores/logsStore';

function seedRows(): void {
  const rows: LogRow[] = [
    { timestamp: 1_700_000_000_000, severity: 'ERROR', service: 'engine', body: 'boom', attributes: {}, rawJson: {} },
    { timestamp: 1_700_000_060_000, severity: 'ERROR', service: 'gateway', body: 'bust', attributes: {}, rawJson: {} },
    { timestamp: 1_700_000_120_000, severity: 'WARN', service: 'engine', body: 'hmm', attributes: {}, rawJson: {} },
  ];
  store.logs.update((s) => ({ ...s, results: rows, totalRows: rows.length }));
}

beforeEach(() => {
  store.__resetForTesting();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  seedRows();
});

afterEach(() => {
  store.__resetForTesting();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LogsCharts', () => {
  it('renders volume, severity, and services panels with row counts', async () => {
    render(LogsCharts);
    flushSync();
    expect(page.getByTestId('logs-charts').element()).toBeTruthy();
    expect(page.getByTestId('logs-chart-volume').element()).toBeTruthy();
    expect(page.getByTestId('logs-chart-severity').element()).toBeTruthy();
    expect(page.getByTestId('logs-chart-services').element()).toBeTruthy();
    // Severity legend shows aggregated counts.
    const errBtn = page.getByTestId('logs-charts-sev-ERROR').element() as HTMLButtonElement;
    expect(errBtn.textContent).toContain('2');
    const warnBtn = page.getByTestId('logs-charts-sev-WARN').element() as HTMLButtonElement;
    expect(warnBtn.textContent).toContain('1');
  });

  it('clicking a severity toggles it in the store filter', async () => {
    render(LogsCharts);
    flushSync();
    // Default severities are WARN+ERROR; clicking ERROR removes it.
    expect(get(store.logs).severities).toContain('ERROR');
    await page.getByTestId('logs-charts-sev-ERROR').element().click();
    flushSync();
    expect(get(store.logs).severities).not.toContain('ERROR');
    expect(get(store.logs).severities).toContain('WARN');
  });

  it('clicking a service toggles it in the store filter', async () => {
    render(LogsCharts);
    flushSync();
    const btn = page
      .getByTestId('logs-charts')
      .element()
      .querySelector<HTMLButtonElement>('[data-service="engine"]');
    expect(btn).toBeTruthy();
    await btn!.click();
    flushSync();
    expect(get(store.logs).services).toContain('engine');
  });

  it('collapse toggle hides the panels', async () => {
    render(LogsCharts);
    flushSync();
    expect(page.getByTestId('logs-chart-volume').query()).toBeTruthy();
    await page.getByTestId('logs-charts-toggle').element().click();
    flushSync();
    expect(page.getByTestId('logs-chart-volume').query()).toBeNull();
  });

});
