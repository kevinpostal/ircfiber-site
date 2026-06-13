import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  memoRenderText,
  memoBlockArt,
  clearFormatCache,
  getFormatCacheStats,
} from './formatCache';

describe('formatCache', () => {
  beforeEach(() => {
    clearFormatCache();
  });

  describe('memoRenderText', () => {
    it('caches the result of the renderer', () => {
      const render = vi.fn((s: string) => `<b>${s}</b>`);
      expect(memoRenderText(render, 'hi')).toBe('<b>hi</b>');
      expect(memoRenderText(render, 'hi')).toBe('<b>hi</b>');
      expect(render).toHaveBeenCalledTimes(1);
    });

    it('does not cache empty strings', () => {
      const render = vi.fn((s: string) => `(${s})`);
      const a = memoRenderText(render, '');
      const b = memoRenderText(render, '');
      expect(a).toBe('()');
      expect(b).toBe('()');
      expect(render).toHaveBeenCalledTimes(2);
    });

    it('evicts the oldest entry when the cache is full', () => {
      const render = (s: string) => s;
      // Fill the cache past MAX_SIZE (500).
      for (let i = 0; i < 600; i++) memoRenderText(render, `text-${i}`);
      const stats = getFormatCacheStats();
      expect(stats.renderSize).toBeLessThanOrEqual(500);

      // The first entries should have been evicted.
      // Calling memoRenderText with `text-0` should re-render.
      const before = getFormatCacheStats();
      memoRenderText(render, 'text-0');
      // text-0 is now in the cache again, so size shouldn't grow.
      const after = getFormatCacheStats();
      expect(after.renderSize).toBe(before.renderSize);
    });

    it('keeps frequently used entries hot', () => {
      const render = vi.fn((s: string) => s);
      // Touch text-A many times.
      for (let i = 0; i < 1000; i++) memoRenderText(render, 'A');
      expect(render).toHaveBeenCalledTimes(1);
    });
  });

  describe('memoBlockArt', () => {
    it('caches boolean results', () => {
      const detect = vi.fn((s: string) => /█/.test(s));
      expect(memoBlockArt(detect, 'a █ b')).toBe(true);
      expect(memoBlockArt(detect, 'a █ b')).toBe(true);
      expect(detect).toHaveBeenCalledTimes(1);

      expect(memoBlockArt(detect, 'no art')).toBe(false);
      expect(memoBlockArt(detect, 'no art')).toBe(false);
      expect(detect).toHaveBeenCalledTimes(2);
    });

    it('does not cache empty strings', () => {
      const detect = vi.fn((s: string) => s.length > 0);
      memoBlockArt(detect, '');
      memoBlockArt(detect, '');
      expect(detect).toHaveBeenCalledTimes(2);
    });

    it('has its own bounded size independent of render cache', () => {
      const detect = (s: string) => s.length > 0;
      for (let i = 0; i < 600; i++) memoBlockArt(detect, `b-${i}`);
      const stats = getFormatCacheStats();
      expect(stats.blockArtSize).toBeLessThanOrEqual(500);
    });
  });

  describe('clearFormatCache', () => {
    it('empties both caches', () => {
      const render = (s: string) => s;
      const detect = (s: string) => true;
      memoRenderText(render, 'a');
      memoBlockArt(detect, 'a');
      expect(getFormatCacheStats().renderSize).toBe(1);
      expect(getFormatCacheStats().blockArtSize).toBe(1);
      clearFormatCache();
      expect(getFormatCacheStats().renderSize).toBe(0);
      expect(getFormatCacheStats().blockArtSize).toBe(0);
    });
  });
});
