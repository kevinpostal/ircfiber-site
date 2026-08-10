import { describe, it, expect } from 'vitest';
import { normalizeImageUrl, extractImageUrlsFromText, IMAGE_EXT_RE } from './imageInline';

describe('IMAGE_EXT_RE', () => {
  it('matches jpg/jpeg/gif/png/webp', () => {
    expect(IMAGE_EXT_RE.test('.jpg')).toBe(true);
    expect(IMAGE_EXT_RE.test('.jpeg')).toBe(true);
    expect(IMAGE_EXT_RE.test('.gif')).toBe(true);
    expect(IMAGE_EXT_RE.test('.png')).toBe(true);
    expect(IMAGE_EXT_RE.test('.webp')).toBe(true);
    expect(IMAGE_EXT_RE.test('.JPG')).toBe(true);
  });
  it('rejects non-image', () => {
    expect(IMAGE_EXT_RE.test('.mp4')).toBe(false);
    expect(IMAGE_EXT_RE.test('.html')).toBe(false);
    expect(IMAGE_EXT_RE.test('.txt')).toBe(false);
  });
});

describe('normalizeImageUrl', () => {
  it('normalizes https image', () => {
    expect(normalizeImageUrl('https://example.com/foo.jpg')).toBe('https://example.com/foo.jpg');
  });
  it('forces https', () => {
    expect(normalizeImageUrl('http://example.com/foo.png')).toBe('https://example.com/foo.png');
  });
  it('rejects non-image', () => {
    expect(normalizeImageUrl('https://example.com/page.html')).toBeNull();
  });
  it('handles query string image', () => {
    expect(normalizeImageUrl('https://example.com/foo.jpg?size=large')).toBe('https://example.com/foo.jpg?size=large');
  });
  it('handles hash image', () => {
    expect(normalizeImageUrl('https://example.com/foo#bar.png')).not.toBeNull();
  });
  it('dropbox rewrite', () => {
    expect(normalizeImageUrl('https://www.dropbox.com/s/abc123/photo.jpg')).toBe(
      'https://dl.dropboxusercontent.com/s/abc123/photo.jpg'
    );
  });
  it('pbs.twimg rewrite', () => {
    expect(normalizeImageUrl('https://pbs.twimg.com/media/ABC123')).toBe(
      'https://pbs.twimg.com/media/ABC123?format=jpg&name=small'
    );
  });
  it('droplr rewrite', () => {
    expect(normalizeImageUrl('https://d.pr/i/xyz')).toBe('https://d.pr/i/xyz+');
  });
  it('webp passes', () => {
    expect(normalizeImageUrl('https://example.com/a.webp')).toBe('https://example.com/a.webp');
  });
  it('case-insensitive', () => {
    expect(normalizeImageUrl('https://example.com/FOO.JpG')).toBe('https://example.com/FOO.JpG');
  });
});

describe('extractImageUrlsFromText', () => {
  it('extracts single image', () => {
    expect(extractImageUrlsFromText('check https://example.com/cat.jpg wow')).toEqual([
      'https://example.com/cat.jpg',
    ]);
  });
  it('extracts multiple, deduped', () => {
    const text =
      'a https://example.com/a.png and https://example.com/b.gif and again https://example.com/a.png';
    expect(extractImageUrlsFromText(text)).toEqual([
      'https://example.com/a.png',
      'https://example.com/b.gif',
    ]);
  });
  it('ignores non-image', () => {
    expect(extractImageUrlsFromText('https://example.com/page.html and https://example.com/video.mp4')).toEqual(
      []
    );
  });
  it('handles trailing punctuation', () => {
    expect(extractImageUrlsFromText('look https://example.com/pic.jpg.')).toEqual([
      'https://example.com/pic.jpg',
    ]);
  });
  it('handles bare domain image', () => {
    expect(extractImageUrlsFromText('see example.com/photo.jpg')).toEqual([
      'https://example.com/photo.jpg',
    ]);
  });
  it('mixed youtube and image - only image returned here', () => {
    expect(
      extractImageUrlsFromText('https://youtu.be/sHuu-kKD0Lc and https://example.com/cat.png')
    ).toEqual(['https://example.com/cat.png']);
  });
});
