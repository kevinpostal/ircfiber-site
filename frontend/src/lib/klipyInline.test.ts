import { describe, it, expect } from 'vitest';
import { extractKlipySlugsFromText, klipyEmbedUrl } from './klipyInline';

describe('extractKlipySlugsFromText', () => {
  it('finds share links with and without scheme, deduped, in order', () => {
    expect(extractKlipySlugsFromText('lol https://klipy.com/gifs/johnny-depp-mad and klipy.com/gifs/hello-hi-662 again https://www.klipy.com/gifs/johnny-depp-mad'))
      .toEqual(['johnny-depp-mad', 'hello-hi-662']);
  });
  it('ignores non-gif pages, other hosts and trailing punctuation', () => {
    expect(extractKlipySlugsFromText('https://klipy.com/stickers/x https://notklipy.com/gifs/y')).toEqual([]);
    expect(extractKlipySlugsFromText('see https://klipy.com/gifs/johnny-depp-mad.')).toEqual(['johnny-depp-mad']);
    expect(extractKlipySlugsFromText('https://klipy.com/gifs/johnny-depp-mad?ref=x')).toEqual(['johnny-depp-mad']);
  });
  it('returns nothing for empty text', () => {
    expect(extractKlipySlugsFromText('')).toEqual([]);
  });
  it('builds the resolver URL', () => {
    expect(klipyEmbedUrl('a-b')).toBe('/api/embed/klipy?slug=a-b');
  });
});
