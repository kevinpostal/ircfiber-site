import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from './fuzzyMatch';

describe('fuzzyMatch', () => {
  it('exact match scores 100', () => {
    expect(fuzzyMatch('#general', '#general')).toBe(100);
    expect(fuzzyMatch('alice', 'alice')).toBe(100);
  });

  it('prefix match scores 60', () => {
    expect(fuzzyMatch('#gen', '#general')).toBe(60);
    expect(fuzzyMatch('ali', 'alice')).toBe(60);
  });

  it('substring match scores 30', () => {
    expect(fuzzyMatch('eral', '#general')).toBe(30);
    expect(fuzzyMatch('ice', 'alice')).toBe(30);
  });

  it('character-by-character match returns positive score < 30', () => {
    // 'gnrl' is not a prefix or substring of '#general' but chars appear in order
    const score = fuzzyMatch('gnrl', '#general');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(30);
  });

  it('no match returns 0', () => {
    expect(fuzzyMatch('xyz', '#general')).toBe(0);
    expect(fuzzyMatch('abc', '')).toBe(0);
  });

  it('empty query returns 0', () => {
    expect(fuzzyMatch('', '#general')).toBe(0);
  });

  it('case insensitive', () => {
    expect(fuzzyMatch('#GENERAL', '#general')).toBe(100);
    expect(fuzzyMatch('#GEN', '#general')).toBe(60);
    expect(fuzzyMatch('GENERAL', '#general')).toBe(30);
  });

  it('ranking: exact > prefix > substring > char-by-char', () => {
    expect(fuzzyMatch('#general', '#general')).toBeGreaterThan(
      fuzzyMatch('#gen', '#general'));
    expect(fuzzyMatch('#gen', '#general')).toBeGreaterThan(
      fuzzyMatch('neral', '#general'));
    expect(fuzzyMatch('neral', '#general')).toBeGreaterThan(
      fuzzyMatch('gnrl', '#general'));
  });

  it('run bonus: consecutive chars score higher than isolated', () => {
    // 'abz' in '#xabcz': 'ab' consecutive (run builds), 'z' isolated
    // NOT a substring: '#xabcz' does not contain 'abz'
    const withRun = fuzzyMatch('abz', '#xabcz');
    // 'abc' in '#xaybzc': all isolated (each run=1)
    const scattered = fuzzyMatch('abc', '#xaybzc');
    expect(withRun).toBeGreaterThan(scattered);
  });

  it('longer char-by-char match scores higher than shorter', () => {
    const longer = fuzzyMatch('gnral', '#general');
    const shorter = fuzzyMatch('gnr', '#general');
    expect(longer).toBeGreaterThan(shorter);
  });

  it('returns 0 when not all query chars match in order', () => {
    expect(fuzzyMatch('abc', 'axy')).toBe(0);
    expect(fuzzyMatch('bac', '#abc')).toBe(0);
  });
});
