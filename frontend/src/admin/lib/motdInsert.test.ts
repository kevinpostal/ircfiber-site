/**
 * insertBanner — the caret splice behind the MOTD raw editor's font picker.
 *
 * Coverage:
 *  1. Banner art always occupies whole lines, whether the caret sits at the
 *     start of the body, mid-line, or on a line boundary.
 *  2. The reported caret lands right after the inserted art, so the next
 *     insert appends below it instead of inside it.
 *  3. A caret outside the body and an empty render are both non-destructive.
 */
import { describe, expect, it } from 'vitest';
import { insertBanner } from './motdInsert';

describe('insertBanner', () => {
  it('inserts into an empty body and terminates the last art line', () => {
    expect(insertBanner('', 0, ['a', 'b'])).toEqual({ body: 'a\nb\n', caret: 4 });
  });

  it('pushes art to its own line when the caret is mid-line and keeps the tail', () => {
    expect(insertBanner('hello world', 5, ['X'])).toEqual({ body: 'hello\nX\n world', caret: 8 });
  });

  it('does not add a blank line when the caret already sits on a boundary', () => {
    expect(insertBanner('a\nb', 2, ['X'])).toEqual({ body: 'a\nX\nb', caret: 4 });
  });

  it('clamps a caret past the end to the end of the body', () => {
    expect(insertBanner('a\n', 99, ['X'])).toEqual({ body: 'a\nX\n', caret: 4 });
  });

  it('leaves the body untouched when the font rendered nothing', () => {
    expect(insertBanner('x', 0, [])).toEqual({ body: 'x', caret: 0 });
  });
});
