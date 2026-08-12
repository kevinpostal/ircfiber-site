import { describe, expect, it } from 'vitest';
import { normalizeHtmlUrl, extractHtmlUrlsFromText } from './htmlInline';

describe('normalizeHtmlUrl', () => {
  it('keeps https upload html', () => {
    expect(normalizeHtmlUrl('https://ircfiber.com/uploads/abc.html')).toContain('/uploads/abc.html');
  });
  it('keeps http for loopback HTM', () => {
    const url = normalizeHtmlUrl('http://localhost:8090/uploads/x.HTM');
    expect(url).not.toBeNull();
    expect(url!.startsWith('http://localhost')).toBe(true);
  });
  it('strips trailing ).', () => {
    const urls = extractHtmlUrlsFromText('see https://example.com/page.html).');
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('page.html');
    expect(urls[0].endsWith(').')).toBe(false);
  });
  it('preserves ?raw=1', () => {
    const url = normalizeHtmlUrl('https://example.com/page.html?raw=1');
    expect(url).toContain('?raw=1');
  });
  it('rejects javascript:', () => {
    expect(normalizeHtmlUrl('javascript:alert(1)')).toBeNull();
  });
  it('forces https for non-loopback http', () => {
    const url = normalizeHtmlUrl('http://example.com/page.html');
    expect(url!.startsWith('https://')).toBe(true);
  });
  it('rejects non-html', () => {
    expect(normalizeHtmlUrl('https://example.com/image.png')).toBeNull();
  });
  it('handles xhtml extension', () => {
    expect(normalizeHtmlUrl('https://example.com/doc.xhtml')).not.toBeNull();
  });
  it('preserves hash', () => {
    const url = normalizeHtmlUrl('https://example.com/page.html#section');
    expect(url).toContain('#section');
  });
});
