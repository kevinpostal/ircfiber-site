/**
 * routing channel-segment round-trip.
 * Regression test: joining `##test` rewrote the URL with one `#`
 * stripped, so every reload/popstate switched the user to `#test`.
 */
import { describe, expect, it } from 'vitest';
import { channelUrlPart, bufferNameFromChannelPart } from './routing';

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
