import { describe, it, expect } from 'vitest';
import { splitTextOnLinks, setChanPrefixChars, detectEmbed } from './autolinker';

describe('splitTextOnLinks', () => {
  it('detects URLs in plain text', () => {
    const parts = splitTextOnLinks('Check out https://example.com today');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ text: 'Check out ', isLink: false });
    expect(parts[1]).toMatchObject({
      text: 'https://example.com',
      isLink: true,
      url: 'https://example.com',
    });
    expect(parts[2]).toEqual({ text: ' today', isLink: false });
  });

  it('detects bare domain URLs', () => {
    const parts = splitTextOnLinks('Visit example.com for more');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatchObject({
      text: 'example.com',
      isLink: true,
      url: 'https://example.com',
    });
  });

  it('detects email addresses', () => {
    const parts = splitTextOnLinks('Contact me@example.com please');
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const email_part = parts.find(p => p.isEmail);
    expect(email_part).toMatchObject({
      text: 'me@example.com',
      isLink: true,
      url: 'mailto:me@example.com',
      isEmail: true,
    });
  });

  it('detects channels with # prefix', () => {
    const parts = splitTextOnLinks('Join #general for chat');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatchObject({
      text: '#general',
      isLink: true,
      isChannel: true,
    });
  });

  it('does not false positive on nicks without #', () => {
    const parts = splitTextOnLinks('Hello alice and bob');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ text: 'Hello alice and bob', isLink: false });
  });

  it('handles multiple links in one text', () => {
    const parts = splitTextOnLinks('See https://a.com and https://b.com');
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const links = parts.filter(p => p.isLink);
    expect(links).toHaveLength(2);
  });

  it('blocks javascript: protocol', () => {
    const parts = splitTextOnLinks('Click javascript:alert(1) here');
    // javascript: should be rejected by cleanUrl
    const links = parts.filter(p => p.isLink);
    expect(links).toHaveLength(0);
  });

  it('returns single non-link part for empty text', () => {
    const parts = splitTextOnLinks('');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ text: '', isLink: false });
  });

  it('strips trailing punctuation from URLs', () => {
    const parts = splitTextOnLinks('Visit https://example.com.');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const url_part = parts.find(p => p.isLink && p.url);
    expect(url_part).toMatchObject({
      text: 'https://example.com',
      isLink: true,
    });
  });

  it('respects balanced parentheses in URLs', () => {
    const parts = splitTextOnLinks('See https://example.com/wiki/(page)');
    expect(parts).toHaveLength(2);
    expect(parts[1].text).toBe('https://example.com/wiki/(page)');
  });
});

describe('setChanPrefixChars', () => {
  it('changes channel prefix detection', () => {
    setChanPrefixChars('&#');
    const parts = splitTextOnLinks('Join &general or #random');
    const channels = parts.filter(p => p.isChannel);
    expect(channels).toHaveLength(2);
    expect(channels[0].text).toBe('&general');
    expect(channels[1].text).toBe('#random');
    // Reset to default
    setChanPrefixChars('#');
  });
});

describe('detectEmbed', () => {
  it('detects youtube URLs', () => {
    expect(detectEmbed('https://youtube.com/watch?v=abc')).toBe('youtube');
    expect(detectEmbed('https://youtu.be/abc')).toBe('youtube');
  });

  it('detects imgur URLs', () => {
    expect(detectEmbed('https://imgur.com/abc')).toBe('imgur');
    expect(detectEmbed('https://i.imgur.com/abc.png')).toBe('imgur');
  });

  it('detects twitter/x URLs', () => {
    expect(detectEmbed('https://twitter.com/user/status/123')).toBe('twitter');
    expect(detectEmbed('https://x.com/user/status/123')).toBe('twitter');
  });

  it('detects wikipedia URLs', () => {
    expect(detectEmbed('https://en.wikipedia.org/wiki/Test')).toBe('wikipedia');
  });

  it('detects reddit URLs', () => {
    expect(detectEmbed('https://reddit.com/r/test')).toBe('reddit');
    expect(detectEmbed('https://redd.it/abc')).toBe('reddit');
  });

  it('detects spotify URLs', () => {
    expect(detectEmbed('https://open.spotify.com/track/abc')).toBe('spotify');
  });

  it('detects gist URLs', () => {
    expect(detectEmbed('https://gist.github.com/user/abc')).toBe('gist');
  });

  it('detects image URLs', () => {
    expect(detectEmbed('https://example.com/pic.png')).toBe('image');
    expect(detectEmbed('https://example.com/pic.jpg')).toBe('image');
    expect(detectEmbed('https://example.com/pic.jpeg')).toBe('image');
    expect(detectEmbed('https://example.com/pic.gif')).toBe('image');
    expect(detectEmbed('https://example.com/pic.webp')).toBe('image');
  });

  it('returns none for unknown URLs', () => {
    expect(detectEmbed('https://example.com/page')).toBe('none');
  });

  it('returns none for invalid URLs', () => {
    expect(detectEmbed('not-a-url')).toBe('none');
  });
});
