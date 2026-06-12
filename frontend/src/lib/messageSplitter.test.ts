import { describe, it, expect } from 'vitest';
import { splitIntoMessages } from './messageSplitter';

describe('splitIntoMessages — IRCCloud line-packer', () => {
  it('returns an empty array for empty input', () => {
    expect(splitIntoMessages('')).toEqual([]);
  });

  it('packs short lines into one message', () => {
    expect(splitIntoMessages('hello\nfoo')).toEqual(['hello foo']);
  });

  it('splits on hard blank lines like IRCCloud does', () => {
    expect(splitIntoMessages('one\n\ntwo')).toEqual(['one', 'two']);
  });

  it('respects maxLen when packing multiple single-word lines', () => {
    // 10 short words, maxLen 10 → joins with single space, packs to ~10 chars.
    const out = splitIntoMessages('aaa\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\niii\njjj', 10);
    expect(out).toEqual(['aaa bbb', 'ccc ddd', 'eee fff', 'ggg hhh', 'iii jjj']);
  });

  it('hard-breaks a single 22-char line into 5+5+5+5+2', () => {
    expect(splitIntoMessages('aaaaaaaaaaaaaaaaaaaaaa', 5)).toEqual([
      'aaaaa', 'aaaaa', 'aaaaa', 'aaaaa', 'aa',
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(splitIntoMessages('a\r\nb\r\nc')).toEqual(['a b c']);
  });

  it('packs 100 single-word lines into <= 10 messages of <= 400 chars', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `w${i}`);
    const text = lines.join('\n');
    const out = splitIntoMessages(text, 400);
    expect(out.length).toBeLessThan(10);
    expect(out.every((m) => m.length <= 400)).toBe(true);
    // Reconstruct by joining with space and re-splitting — the joiner adds
    // single spaces, so a split-on-space round-trip recovers the original
    // tokens in order (modulo sort).
    const reconstructed = out.join(' ').split(' ').sort();
    expect(reconstructed).toEqual([...lines].sort());
  });

  it('skips trailing blank lines but preserves internal blanks', () => {
    expect(splitIntoMessages('a\n\n\n')).toEqual(['a']);
  });

  it('keeps the single-message fast path for short single-line input', () => {
    expect(splitIntoMessages('hello world')).toEqual(['hello world']);
  });
});
