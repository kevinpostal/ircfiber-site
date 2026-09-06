import { describe, it, expect } from 'vitest';
import { splitHighlightedLines } from './codeLines';

describe('splitHighlightedLines', () => {
  it('splits plain text into one entry per line, keeping empty lines', () => {
    expect(splitHighlightedLines('a\n\nb')).toEqual(['a', '', 'b']);
  });

  it('closes and reopens a token that spans a newline', () => {
    // A block comment is one hljs span containing a newline. Split naively,
    // line 1 has an unclosed <span> and the browser's error recovery bleeds
    // the comment colour over every line after it.
    const html = '<span class="hljs-comment">/* one\ntwo */</span>\ncode';
    const lines = splitHighlightedLines(html);
    expect(lines).toEqual([
      '<span class="hljs-comment">/* one</span>',
      '<span class="hljs-comment">two */</span>',
      'code',
    ]);
    for (const line of lines) {
      const opened = (line.match(/<span/g) ?? []).length;
      const closed = (line.match(/<\/span>/g) ?? []).length;
      expect(opened).toBe(closed);
    }
  });

  it('reopens every level of a nested token', () => {
    const html = '<span class="a"><span class="b">x\ny</span></span>';
    expect(splitHighlightedLines(html)).toEqual([
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b">y</span></span>',
    ]);
  });

  it('leaves escaped entities untouched', () => {
    expect(splitHighlightedLines('&lt;a&gt;\n&amp;')).toEqual(['&lt;a&gt;', '&amp;']);
  });
});
