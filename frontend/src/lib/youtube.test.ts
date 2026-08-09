import { describe, it, expect } from 'vitest';
import { extractYoutubeId, extractYoutubeIdsFromText, youtubeEmbedUrl } from './youtube';

describe('extractYoutubeId', () => {
  it('youtu.be', () => {
    expect(extractYoutubeId('https://youtu.be/sHuu-kKD0Lc')).toBe('sHuu-kKD0Lc');
  });
  it('watch v=', () => {
    expect(extractYoutubeId('https://www.youtube.com/watch?v=sHuu-kKD0Lc')).toBe('sHuu-kKD0Lc');
  });
  it('watch with extra params', () => {
    expect(extractYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=10s')).toBe('dQw4w9WgXcQ');
  });
  it('embed', () => {
    expect(extractYoutubeId('https://www.youtube.com/embed/sHuu-kKD0Lc')).toBe('sHuu-kKD0Lc');
  });
  it('shorts', () => {
    expect(extractYoutubeId('https://www.youtube.com/shorts/sHuu-kKD0Lc')).toBe('sHuu-kKD0Lc');
  });
  it('youtube-nocookie', () => {
    expect(extractYoutubeId('https://www.youtube-nocookie.com/embed/sHuu-kKD0Lc')).toBe('sHuu-kKD0Lc');
  });
  it('music.youtube.com', () => {
    expect(extractYoutubeId('https://music.youtube.com/watch?v=sHuu-kKD0Lc')).toBe('sHuu-kKD0Lc');
  });
  it('reject non-youtube', () => {
    expect(extractYoutubeId('https://example.com/watch?v=sHuu-kKD0Lc')).toBeNull();
  });
});

describe('extractYoutubeIdsFromText', () => {
  it('extracts multiple ids, deduped', () => {
    const text = 'check https://youtu.be/sHuu-kKD0Lc wow and https://www.youtube.com/watch?v=dQw4w9WgXcQ and again https://youtu.be/sHuu-kKD0Lc';
    expect(extractYoutubeIdsFromText(text)).toEqual(['sHuu-kKD0Lc', 'dQw4w9WgXcQ']);
  });
  it('handles trailing punctuation', () => {
    expect(extractYoutubeIdsFromText('see https://youtu.be/sHuu-kKD0Lc.')).toEqual(['sHuu-kKD0Lc']);
  });
  it('empty returns []', () => {
    expect(extractYoutubeIdsFromText('no links here')).toEqual([]);
  });
});

describe('youtubeEmbedUrl', () => {
  it('builds embed url with id and params', () => {
    const url = youtubeEmbedUrl('sHuu-kKD0Lc');
    expect(url).toContain('/embed/sHuu-kKD0Lc');
    expect(url).toContain('autoplay=0');
    expect(url).toContain('modestbranding=1');
  });
});
