import { describe, it, expect } from 'vitest';
import { parseIrcFormatting, stripIrcFormatting } from './ircFormatting';

describe('parseIrcFormatting', () => {
  it('parses bold text', () => {
    const input = '\x02hello world';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span class="bold">hello world</span>');
  });

  it('parses italic text', () => {
    const input = '\x1Dhello world';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span class="italic">hello world</span>');
  });

  it('parses underline text', () => {
    const input = '\x1Fhello world';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span class="underline">hello world</span>');
  });

  it('parses mIRC color with foreground only', () => {
    const input = '\x0304red text';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span class="irccolor color-4">red text</span>');
  });

  it('parses mIRC color with foreground and background', () => {
    const input = '\x0304,08red on yellow';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span class="irccolor color-4 irccolor-bg bg-8">red on yellow</span>');
  });

  it('handles nested formatting (bold + color)', () => {
    const input = '\x02\x0304bold and red';
    const result = parseIrcFormatting(input);
    // Bold toggle creates an empty tag first, then color opens combined
    expect(result).toBe('<wbr><span class="bold"></span><wbr><span class="bold irccolor color-4">bold and red</span>');
  });

  it('handles reset code (\x0F)', () => {
    const input = '\x02bold\x0Fnormal';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span class="bold">bold</span>normal');
  });

  it('parses monospace text', () => {
    const input = '\x11monospace text';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span class="monospace">monospace text</span>');
  });

  it('parses strikethrough text', () => {
    const input = '\x1Estrikethrough text';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span class="strikethrough">strikethrough text</span>');
  });

  it('parses extended colors 16-98', () => {
    const input = '\x0352extended red';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span style="color:#ff0000;">extended red</span>');
  });

  it('parses extended background colors', () => {
    const input = '\x0352,56red on lime';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span style="color:#ff0000;background-color:#00ff00;">red on lime</span>');
  });

  it('parses hex RGB colors (\x04)', () => {
    const input = '\x04FF0000hex red';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span style="color:#FF0000;">hex red</span>');
  });

  it('parses hex RGB with foreground and background', () => {
    const input = '\x04FF0000,00FF00hex colored';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span style="color:#FF0000;background-color:#00FF00;">hex colored</span>');
  });

  it('leaves backticks as literal characters (no markdown code interpretation)', () => {
    const input = '`inline code`';
    const result = parseIrcFormatting(input);
    // IRCCloud doesn't interpret backticks as code — they're literal characters
    expect(result).toBe('`inline code`');
  });

  it('leaves triple backticks as literal characters', () => {
    const input = '```some code```';
    const result = parseIrcFormatting(input);
    expect(result).toBe('```some code```');
  });

  it('leaves blockquote markers as literal characters', () => {
    const input = '> this is a quote';
    const result = parseIrcFormatting(input);
    expect(result).toBe('&gt; this is a quote');
  });

  it('escapes HTML entities in plain text', () => {
    const input = 'hello <world> & "test"';
    const result = parseIrcFormatting(input);
    expect(result).toBe('hello &lt;world&gt; &amp; &quot;test&quot;');
  });

  it('returns empty string for empty input', () => {
    expect(parseIrcFormatting('')).toBe('');
    expect(parseIrcFormatting(null as unknown as string)).toBe('');
    expect(parseIrcFormatting(undefined as unknown as string)).toBe('');
  });

  it('handles color 99 (transparent)', () => {
    const input = '\x0399transparent text';
    const result = parseIrcFormatting(input);
    expect(result).toBe('<wbr><span style="color:transparent;">transparent text</span>');
  });
});

describe('stripIrcFormatting', () => {
  it('removes bold codes', () => {
    const input = '\x02bold\x02 text';
    expect(stripIrcFormatting(input)).toBe('bold text');
  });

  it('removes italic codes', () => {
    const input = '\x1Ditalic\x1D text';
    expect(stripIrcFormatting(input)).toBe('italic text');
  });

  it('removes underline codes', () => {
    const input = '\x1Funderline\x1F text';
    expect(stripIrcFormatting(input)).toBe('underline text');
  });

  it('removes mIRC color codes', () => {
    const input = '\x0304,08colored text';
    expect(stripIrcFormatting(input)).toBe('colored text');
  });

  it('removes hex RGB color codes', () => {
    const input = '\x04FF0000hex colored';
    expect(stripIrcFormatting(input)).toBe('hex colored');
  });

  it('removes reset codes', () => {
    const input = 'before\x0Fafter';
    expect(stripIrcFormatting(input)).toBe('beforeafter');
  });

  it('removes all formatting codes together', () => {
    const input = '\x02\x1D\x1F\x0304,08\x04FF0000formatted\x0F';
    expect(stripIrcFormatting(input)).toBe('formatted');
  });

  it('returns empty string for empty input', () => {
    expect(stripIrcFormatting('')).toBe('');
    expect(stripIrcFormatting(null as unknown as string)).toBe('');
    expect(stripIrcFormatting(undefined as unknown as string)).toBe('');
  });
});
