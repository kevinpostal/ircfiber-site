import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setPerfEnabled, isPerfEnabled, perfMark, perfMeasure } from './perf';

describe('perf', () => {
  beforeEach(() => {
    setPerfEnabled(false);
  });

  afterEach(() => {
    setPerfEnabled(false);
  });

  it('is disabled by default', () => {
    expect(isPerfEnabled()).toBe(false);
  });

  it('marks and measures do not run when disabled', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = perfMark('test');
    const d = perfMeasure('test', m);
    expect(m).toBeNull();
    expect(d).toBeNull();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('marks and measures run when enabled', () => {
    setPerfEnabled(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = perfMark('start');
    expect(m).toBeTypeOf('number');
    expect(log).toHaveBeenCalled();
    log.mockClear();
    const d = perfMeasure('end', m);
    expect(d).toBeTypeOf('number');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('measure returns null when start is null', () => {
    setPerfEnabled(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(perfMeasure('end', null)).toBeNull();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
