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
    const urls = extractHtmlUrlsFromText('see https://ircfiber.com/uploads/page.html).');
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('page.html');
    expect(urls[0].endsWith(').')).toBe(false);
  });
  it('preserves ?raw=1', () => {
    const url = normalizeHtmlUrl('https://ircfiber.com/uploads/page.html?raw=1');
    expect(url).toContain('?raw=1');
  });
  it('rejects javascript:', () => {
    expect(normalizeHtmlUrl('javascript:alert(1)')).toBeNull();
  });
  it('forces https for non-loopback http', () => {
    const url = normalizeHtmlUrl('http://ircfiber.com/uploads/page.html');
    expect(url!.startsWith('https://')).toBe(true);
  });
  it('rejects non-html', () => {
    expect(normalizeHtmlUrl('https://ircfiber.com/uploads/image.png')).toBeNull();
  });
  it('handles xhtml extension', () => {
    expect(normalizeHtmlUrl('https://ircfiber.com/uploads/doc.xhtml')).not.toBeNull();
  });
  it('preserves hash', () => {
    const url = normalizeHtmlUrl('https://ircfiber.com/uploads/page.html#section');
    expect(url).toContain('#section');
  });
  it('rejects external html not under /uploads/', () => {
    expect(normalizeHtmlUrl('https://www.elecrow.com/thinknode-m9-meshcore-communication-terminal-with-full-keyboard-2-4inch-lcd-esp32-s3-lr1110-gps-2300mah.html')).toBeNull();
    expect(extractHtmlUrlsFromText('see https://www.elecrow.com/thinknode-m9-meshcore-communication-terminal-with-full-keyboard-2-4inch-lcd-esp32-s3-lr1110-gps-2300mah.html')).toHaveLength(0);
  });
});
