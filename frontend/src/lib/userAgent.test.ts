import { describe, it, expect } from 'vitest';
import { describeUserAgent } from './userAgent';

describe('describeUserAgent', () => {
  it('Chrome on macOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
    expect(describeUserAgent(ua)).toEqual({
      browser: 'Chrome 152',
      os: 'macOS',
      label: 'Chrome 152 on macOS',
    });
  });

  it('Safari on iOS reads the product version out of Version/, not Safari/', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    expect(describeUserAgent(ua)).toEqual({
      browser: 'Safari 18.1',
      os: 'iOS 18',
      label: 'Safari 18.1 on iOS 18',
    });
    // A point-zero release is just "Safari 17".
    const dotZero =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    expect(describeUserAgent(dotZero).label).toBe('Safari 17 on macOS');
  });

  it('Firefox on Windows', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';
    expect(describeUserAgent(ua)).toEqual({
      browser: 'Firefox 131',
      os: 'Windows',
      label: 'Firefox 131 on Windows',
    });
  });

  it('Edge on Windows is Edge, never the Chrome token it also carries', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.2792.52';
    const got = describeUserAgent(ua);
    expect(got).toEqual({ browser: 'Edge 152', os: 'Windows', label: 'Edge 152 on Windows' });
    expect(got.label).not.toContain('Chrome');
  });

  it('Chrome on Android keeps the Android release', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36';
    expect(describeUserAgent(ua)).toEqual({
      browser: 'Chrome 152',
      os: 'Android 15',
      label: 'Chrome 152 on Android 15',
    });
  });

  it('curl names the tool and admits it has no OS', () => {
    expect(describeUserAgent('curl/8.7.1')).toEqual({
      browser: 'curl 8.7.1',
      os: '',
      label: 'curl 8.7.1',
    });
  });

  it('a crawler is reported verbatim, not as the browser it impersonates', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    const got = describeUserAgent(ua);
    expect(got.browser).toBe('');
    expect(got.os).toBe('');
    expect(got.label).toBe(`${ua.slice(0, 79)}…`);
    expect(got.label).toHaveLength(80);
  });

  it('an empty or blank UA reads "Unknown client"', () => {
    expect(describeUserAgent('')).toEqual({ browser: '', os: '', label: 'Unknown client' });
    expect(describeUserAgent('   ').label).toBe('Unknown client');
  });

  it('an unparseable UA falls back to the raw string', () => {
    expect(describeUserAgent('totally-made-up/1')).toEqual({
      browser: '',
      os: '',
      label: 'totally-made-up/1',
    });
  });
});
