/**
 * routing channel-segment round-trip.
 * Regression test: joining `##test` rewrote the URL with one `#`
 * stripped, so every reload/popstate switched the user to `#test`.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  channelUrlPart,
  bufferNameFromChannelPart,
  navigateBackFromPastebin,
} from './routing';

function roundTrip(bufferName: string): string {
  return bufferNameFromChannelPart(decodeURIComponent(channelUrlPart(bufferName)));
}

describe('channel URL round-trip', () => {
  it('preserves double-hash channels', () => {
    expect(roundTrip('##test')).toBe('##test');
  });

  it('preserves single-hash channels', () => {
    expect(roundTrip('#test')).toBe('#test');
  });

  it('preserves other chantypes', () => {
    expect(roundTrip('&foo')).toBe('&foo');
  });

  it('still reads legacy prefix-stripped segments', () => {
    // Old URLs stored `/channel/test` for `#test`.
    expect(bufferNameFromChannelPart('test')).toBe('#test');
  });

  it('does not double-prefix', () => {
    expect(bufferNameFromChannelPart('#test')).toBe('#test');
    expect(bufferNameFromChannelPart('##test')).toBe('##test');
  });
});

describe('navigateBackFromPastebin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('goes back when there is in-app history', () => {
    const back = vi.fn();
    vi.stubGlobal('history', { back });
    vi.stubGlobal('window', {
      history: { length: 5 },
      location: { href: '' },
    });
    navigateBackFromPastebin();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('falls back to / for direct-link visitors with no history', () => {
    const back = vi.fn();
    const location = { href: '' };
    vi.stubGlobal('history', { back });
    vi.stubGlobal('window', { history: { length: 1 }, location });
    navigateBackFromPastebin();
    expect(back).not.toHaveBeenCalled();
    expect(location.href).toBe('/');
  });
});
