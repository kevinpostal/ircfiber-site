import { describe, it, expect } from 'vitest';
import { extractTextUrlsFromText } from './textInline';

describe('pastebin inline extraction', () => {
  it('extracts /?/pastebin= viewer URLs as inline', () => {
    const text = 'check https://ircfiber.com/?/pastebin=8df764c9-3f89-4cd7-bd22-26b48a1dc6cc cool';
    const urls = extractTextUrlsFromText(text);
    expect(urls).toContain('https://ircfiber.com/?/pastebin=8df764c9-3f89-4cd7-bd22-26b48a1dc6cc');
  });

  it('extracts /api/pastebins/.../raw URLs', () => {
    const text = 'raw https://ircfiber.com/api/pastebins/8df764c9-3f89-4cd7-bd22-26b48a1dc6cc/raw';
    const urls = extractTextUrlsFromText(text);
    expect(urls.some(u => u.includes('/api/pastebins/'))).toBe(true);
  });

  it('still extracts /uploads/ URLs', () => {
    const text = 'file https://ircfiber.com/uploads/abc123.txt';
    const urls = extractTextUrlsFromText(text);
    expect(urls[0]).toContain('/uploads/');
  });
});
