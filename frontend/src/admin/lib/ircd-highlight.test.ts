/**
 * ircd-highlight — tokenizer checks for the IRCD config viewer.
 * Pure string in/out, no DOM needed.
 */
import { describe, expect, it } from 'vitest';
import { highlightIrcdConf } from './ircd-highlight';

describe('highlightIrcdConf', () => {
  it('highlights comments as a whole line', () => {
    const out = highlightIrcdConf('# a comment\n#indented');
    expect(out).toContain('<span class="text-muted italic"># a comment</span>');
    expect(out).not.toContain('tok-tag');
  });

  it('highlights tag names, attributes and quoted strings', () => {
    const out = highlightIrcdConf('<server name="irc.example.com" id="1AB">');
    expect(out).toContain('<span class="text-primary font-semibold">server</span>');
    expect(out).toContain('<span class="text-info">name</span>');
    expect(out).toContain('<span class="text-success">&quot;irc.example.com&quot;</span>');
    expect(out).toContain('<span class="text-success">&quot;1AB&quot;</span>');
  });

  it('escapes HTML before decorating', () => {
    const out = highlightIrcdConf('<badnick nick="A<B" reason="x&y">');
    expect(out).not.toContain('<B');
    expect(out).toContain('&lt;B');
    expect(out).toContain('x&amp;y');
  });

  it('leaves plain text lines untouched', () => {
    expect(highlightIrcdConf('just words')).toBe('just words');
    expect(highlightIrcdConf('')).toBe('');
  });

  it('handles values containing entities', () => {
    // prefixpart="&quot;" — the inner entity must not break the string span
    const out = highlightIrcdConf('<options prefixpart="&quot;" suffixquit="&quot;">');
    expect(out).toContain('<span class="text-success">&quot;&amp;quot;&quot;</span>');
  });
});
