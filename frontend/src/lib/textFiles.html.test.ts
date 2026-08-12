import { describe, expect, it } from 'vitest';
import { isHtmlFile } from './textFiles';

describe('isHtmlFile', () => {
  it('returns true for index.html with empty mime', () => {
    expect(isHtmlFile({ name: 'index.html', type: '' })).toBe(true);
  });
  it('returns true for page.HTM with octet-stream', () => {
    expect(isHtmlFile({ name: 'page.HTM', type: 'application/octet-stream' })).toBe(true);
  });
  it('returns true for x.xhtml with text/plain', () => {
    expect(isHtmlFile({ name: 'x.xhtml', type: 'text/plain' })).toBe(true);
  });
  it('returns true for foo.txt with text/html mime (mime wins)', () => {
    expect(isHtmlFile({ name: 'foo.txt', type: 'text/html' })).toBe(true);
  });
  it('returns false for photo.html.png with image/png (image wins)', () => {
    expect(isHtmlFile({ name: 'photo.html.png', type: 'image/png' })).toBe(false);
  });
  it('returns true for mime application/xhtml+xml', () => {
    expect(isHtmlFile({ name: 'foo.txt', type: 'application/xhtml+xml' })).toBe(true);
  });
  it('supports string overload', () => {
    expect(isHtmlFile('text/html', 'foo.txt')).toBe(true);
    expect(isHtmlFile('image/png', 'photo.html.png')).toBe(false);
  });
  it('returns false for plain txt', () => {
    expect(isHtmlFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });
});
