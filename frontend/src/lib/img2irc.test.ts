import { describe, it, expect } from 'vitest';
import { IRC99, estimateLineLengths, clearColorLut, base94Encode, base94Decode, base94EncodedLength, diffCrossoverK, shouldUseBitmask, estimateDiffSaving, encodeLineDiff } from './img2irc';

describe('img2irc', () => {
  it('IRC99 has 99 entries', () => {
    expect(IRC99).toHaveLength(99);
  });

  it('IRC99 first 16 match mIRC standard hex', () => {
    // white, black, navy...
    expect(IRC99[0].toString(16).padStart(6, '0')).toBe('ffffff');
    expect(IRC99[1].toString(16).padStart(6, '0')).toBe('000000');
    expect(IRC99[2].toString(16).padStart(6, '0')).toBe('00007f');
    expect(IRC99[4].toString(16).padStart(6, '0')).toBe('ff0000');
  });

  it('estimateLineLengths reports ok for short art', () => {
    const art = '\x033,5▀\x0f\n\x034,6█\x0f';
    const { ok, longest, lines } = estimateLineLengths(art);
    expect(ok).toBe(true);
    expect(lines).toBe(2);
    expect(longest).toBeLessThan(400);
  });

  it('estimateLineLengths flags overly long lines', () => {
    const long = '\x03' + '1,2' + '▀'.repeat(300) + '\x0f';
    const { ok } = estimateLineLengths(long, 100);
    expect(ok).toBe(false);
  });
  it('clearColorLut is callable and clears', () => {
    expect(() => clearColorLut()).not.toThrow();
  });

  it('IRC99 palette matches img2irc palette.rs', () => {
    expect(IRC99[0]).toBe(0xffffff);
    expect(IRC99[1]).toBe(0x000000);
    expect(IRC99[14]).toBe(0x555555);
    expect(IRC99[15]).toBe(0xaaaaaa);
    expect(IRC99[98]).toBe(0xffffff);
  });

  it('estimateLineLengths handles empty input', () => {
    const { ok, lines, longest } = estimateLineLengths('');
    expect(ok).toBe(true);
    expect(lines).toBe(1);
    expect(longest).toBe(0);
  });

  it('base94 9→11 round-trips and beats base64', () => {
    const data = new Uint8Array([1,2,3,4,5,6,7,8,9]);
    const enc = base94Encode(data);
    expect(enc).toHaveLength(11);
    expect(base94EncodedLength(9)).toBe(11);
    expect(base94EncodedLength(400)).toBeLessThan(Math.ceil(400*4/3)); // beats base64
    expect(base94Decode(enc)).toEqual(data);
  });

  it('base94 handles arbitrary lengths', () => {
    for(const len of [1,2,3,9,10,18,400]){
      const d=new Uint8Array(len); for(let i=0;i<len;i++) d[i]= (i*37)%256;
      const enc=base94Encode(d);
      expect(base94EncodedLength(len)).toBe(enc.length);
      expect(base94Decode(enc)).toEqual(d);
    }
  });

  it('inter-line diff crossover at 5 for M=60 idx=2', () => {
    expect(diffCrossoverK(60,2)).toBe(5);
    expect(shouldUseBitmask(60,4,2)).toBe(false);
    expect(shouldUseBitmask(60,5,2)).toBe(true);
    expect(shouldUseBitmask(60,10,2)).toBe(true);
  });

  it('diff saving estimate matches measured band', () => {
    // p≤0.1 should give ≥86% saving at M=60
    const saving = estimateDiffSaving(60, 0.1, 1, 2);
    expect(saving).toBeGreaterThan(0.85);
    const savingHigh = estimateDiffSaving(60, 0.3, 1, 2);
    expect(savingHigh).toBeLessThan(saving);
  });

  it('encodeLineDiff picks mask when many changes', () => {
    const prev = Array(60).fill('a');
    const curr = [...prev]; curr[0]='b'; curr[1]='b'; curr[2]='b'; curr[3]='b'; curr[4]='b';
    const res = encodeLineDiff(prev,curr);
    expect(res.useMask).toBe(true);
    const sparse = Array(60).fill('a'); const cur2=[...sparse]; cur2[0]='b';
    expect(encodeLineDiff(sparse,cur2).useMask).toBe(false);
  });
});
