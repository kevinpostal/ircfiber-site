import { describe, it, expect } from 'vitest';
import { InputHistory } from './inputHistory';

describe('InputHistory', () => {
  describe('push', () => {
    it('adds text to history', () => {
      const history = new InputHistory();
      history.push('hello');
      expect(history.getEarlier('')).toBe('hello');
    });

    it('ignores duplicate pushes', () => {
      const history = new InputHistory();
      history.push('hello');
      history.push('hello');
      history.push('world');
      expect(history.getEarlier('')).toBe('world');
      expect(history.getEarlier('')).toBe('hello');
    });

    it('limits history to 100 entries', () => {
      const history = new InputHistory();
      for (let i = 0; i < 105; i++) {
        history.push(`msg${i}`);
      }
      // The oldest entries should have been dropped
      let count = 0;
      history.resetIndex();
      while (history.getEarlier('') !== undefined) {
        count++;
      }
      expect(count).toBe(100);
    });
  });

  describe('getEarlier', () => {
    it('navigates backwards through history', () => {
      const history = new InputHistory();
      history.push('first');
      history.push('second');
      history.push('third');

      expect(history.getEarlier('')).toBe('third');
      expect(history.getEarlier('')).toBe('second');
      expect(history.getEarlier('')).toBe('first');
    });

    it('returns undefined when at start of history', () => {
      const history = new InputHistory();
      history.push('only');
      history.getEarlier('');
      expect(history.getEarlier('')).toBeUndefined();
    });

    it('saves current input on first up arrow', () => {
      const history = new InputHistory();
      history.push('first');
      history.push('second');

      const current_input = 'typing...';
      expect(history.getEarlier(current_input)).toBe('second');
      expect(history.getLater()).toBe(current_input);
    });

    it('returns undefined for empty history', () => {
      const history = new InputHistory();
      expect(history.getEarlier('')).toBeUndefined();
    });
  });

  describe('getLater', () => {
    it('navigates forwards through history', () => {
      const history = new InputHistory();
      history.push('first');
      history.push('second');

      history.getEarlier('');
      history.getEarlier('');
      expect(history.getLater()).toBe('second');
    });

    it('returns to current input when reaching end', () => {
      const history = new InputHistory();
      history.push('first');
      const current_input = 'typing...';

      history.getEarlier(current_input);
      expect(history.getLater()).toBe(current_input);
    });

    it('returns undefined when index is at zero', () => {
      const history = new InputHistory();
      expect(history.getLater()).toBeUndefined();
    });
  });

  describe('resetIndex', () => {
    it('resets navigation index', () => {
      const history = new InputHistory();
      history.push('first');
      history.push('second');

      history.getEarlier('');
      history.resetIndex();
      expect(history.getLater()).toBeUndefined();
      expect(history.getEarlier('')).toBe('second');
    });
  });

  describe('isMultiline', () => {
    it('returns true for text with newline', () => {
      expect(InputHistory.isMultiline('line1\nline2')).toBe(true);
    });

    it('returns false for single line text', () => {
      expect(InputHistory.isMultiline('single line')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(InputHistory.isMultiline('')).toBe(false);
    });
  });
});
