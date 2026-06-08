import { escapeHtml } from './utils';

// Extended mIRC color palette: codes 16-98 map to hex RGB
const EXTENDED_COLORS: Record<number, string> = {
  16: '#470000', 17: '#472100', 18: '#474700', 19: '#324700', 20: '#004700',
  21: '#00472c', 22: '#004747', 23: '#002747', 24: '#000047', 25: '#2e0047',
  26: '#470047', 27: '#47002a', 28: '#740000', 29: '#743a00', 30: '#747400',
  31: '#517400', 32: '#007400', 33: '#007449', 34: '#007474', 35: '#004074',
  36: '#000074', 37: '#4b0074', 38: '#740074', 39: '#740045', 40: '#b50000',
  41: '#b56300', 42: '#b5b500', 43: '#7db500', 44: '#00b500', 45: '#00b571',
  46: '#00b5b5', 47: '#0063b5', 48: '#0000b5', 49: '#7500b5', 50: '#b500b5',
  51: '#b5006b', 52: '#ff0000', 53: '#ff8c00', 54: '#ffff00', 55: '#b2ff00',
  56: '#00ff00', 57: '#00ffa0', 58: '#00ffff', 59: '#008cff', 60: '#0000ff',
  61: '#a500ff', 62: '#ff00ff', 63: '#ff0098', 64: '#ff5959', 65: '#ffb459',
  66: '#ffff71', 67: '#cfff60', 68: '#6fff6f', 69: '#65ffc9', 70: '#6dffff',
  71: '#59b4ff', 72: '#5959ff', 73: '#c459ff', 74: '#ff66ff', 75: '#ff59bc',
  76: '#ff9c9c', 77: '#ffd39c', 78: '#ffff9c', 79: '#e2ff9c', 80: '#9cff9c',
  81: '#9cffdb', 82: '#9cffff', 83: '#9cd3ff', 84: '#9c9cff', 85: '#dc9cff',
  86: '#ff9cff', 87: '#ff94d3', 88: '#000000', 89: '#131313', 90: '#282828',
  91: '#363636', 92: '#4d4d4d', 93: '#656565', 94: '#818181', 95: '#9f9f9f',
  96: '#bcbcbc', 97: '#e2e2e2', 98: '#ffffff',
};

/**
 * Parse IRC formatting codes and produce safe HTML.
 *
 * Handles: bold (0x02), italic (0x1D), underline (0x1F), reverse (0x16),
 * monospace (0x11), strikethrough (0x1E), mIRC colors 0-98 (0x03),
 * hex RGB (0x04), reset (0x0F), markdown code blocks, blockquotes.
 */
export function parseIrcFormatting(text: string): string {
  if (!text) return '';

  // Pre-process markdown-style formatting before IRC control codes
  text = processBlockFormatting(text);

  let i = 0;
  let out = '';
  let bold = false, italic = false, underline = false, reverse = false;
  let monospace = false, strikethrough = false;
  let fg: number | null = null, bg: number | null = null;
  let hexFg: string | null = null, hexBg: string | null = null;
  let openStack = 0;

  function closeAll(): void {
    for (let k = 0; k < openStack; k++) out += '</span>';
    openStack = 0;
  }

  function makeOpen(): string {
    const classes: string[] = [];
    if (bold) classes.push('bold');
    if (italic) classes.push('italic');
    if (underline) classes.push('underline');
    if (reverse) classes.push('reverse');
    if (monospace) classes.push('monospace');
    if (strikethrough) classes.push('strikethrough');
    if (fg !== null && fg <= 15) classes.push(`irccolor color-${fg}`);
    if (bg !== null && bg <= 15) classes.push(`irccolor-bg bg-${bg}`);
    let style = '';
    if (fg !== null && fg >= 16 && fg <= 98 && EXTENDED_COLORS[fg]) {
      style += `color:${EXTENDED_COLORS[fg]};`;
    }
    if (bg !== null && bg >= 16 && bg <= 98 && EXTENDED_COLORS[bg]) {
      style += `background-color:${EXTENDED_COLORS[bg]};`;
    }
    if (fg === 99) style += 'color:transparent;';
    if (bg === 99) style += 'background-color:transparent;';
    if (hexFg !== null) style += `color:#${hexFg};`;
    if (hexBg !== null) style += `background-color:#${hexBg};`;
    if (classes.length === 0 && !style) return '';
    const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
    const sty = style ? ` style="${style}"` : '';
    return `<span${cls}${sty}>`;
  }

  while (i < text.length) {
    const ch = text.charCodeAt(i);
    let stateChanged = false;

    if (ch === 0x02) { bold = !bold; stateChanged = true; i++; }
    else if (ch === 0x1D) { italic = !italic; stateChanged = true; i++; }
    else if (ch === 0x1F) { underline = !underline; stateChanged = true; i++; }
    else if (ch === 0x16) { reverse = !reverse; stateChanged = true; i++; }
    else if (ch === 0x11) { monospace = !monospace; stateChanged = true; i++; }
    else if (ch === 0x1E) { strikethrough = !strikethrough; stateChanged = true; i++; }
    else if (ch === 0x0F) {
      bold = false; italic = false; underline = false; reverse = false;
      monospace = false; strikethrough = false;
      fg = null; bg = null; hexFg = null; hexBg = null;
      stateChanged = true; i++;
    }
    else if (ch === 0x03) {
      i++;
      let fnum = '';
      for (let k = 0; k < 2 && i < text.length; k++) {
        const c = text.charCodeAt(i);
        if (c >= 0x30 && c <= 0x39) { fnum += text[i]; i++; } else break;
      }
      let hadComma = false;
      let bnum = '';
      if (i < text.length && text.charCodeAt(i) === 0x2C) {
        hadComma = true; i++;
        for (let k = 0; k < 2 && i < text.length; k++) {
          const c = text.charCodeAt(i);
          if (c >= 0x30 && c <= 0x39) { bnum += text[i]; i++; } else break;
        }
      }
      if (fnum.length > 0) fg = parseInt(fnum, 10);
      else if (!hadComma) fg = null;
      if (hadComma) bg = bnum.length > 0 ? parseInt(bnum, 10) : null;
      if (fnum.length === 0 && !hadComma) { fg = null; bg = null; }
      hexFg = null; hexBg = null;
      stateChanged = true;
    }
    else if (ch === 0x04) {
      i++;
      let hf = '', hb = '';
      for (let k = 0; k < 6 && i < text.length; k++) {
        const c = text.charCodeAt(i);
        if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) {
          hf += text[i]; i++;
        } else break;
      }
      if (i < text.length && text.charCodeAt(i) === 0x2C) {
        i++;
        for (let k = 0; k < 6 && i < text.length; k++) {
          const c = text.charCodeAt(i);
          if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) {
            hb += text[i]; i++;
          } else break;
        }
      }
      hexFg = hf.length === 6 ? hf : null;
      hexBg = hb.length === 6 ? hb : null;
      fg = null; bg = null;
      stateChanged = true;
    }
    else {
      out += escapeHtml(text[i]);
      i++;
    }

    if (stateChanged) {
      closeAll();
      const openTag = makeOpen();
      if (openTag) {
        // <wbr> gives the browser a line-wrap opportunity between colored
        // block-character spans. Default <wbr> rendering is zero-width,
        // matching IRCCloud exactly.
        out += '<wbr>' + openTag;
        openStack = 1;
      }
    }
  }
  closeAll();
  return out;
}

/**
 * Process markdown-style block formatting before IRC control codes.
 * Handles: triple-backtick code blocks, single-backtick inline code, blockquotes.
 */
function processBlockFormatting(text: string): string {
  // Triple backtick code blocks
  text = text.replace(/```([^`]+)```/g, '<pre class="codeBlock">$1</pre>');

  // Single backtick inline code
  text = text.replace(/`([^`\n]+)`/g, '<code class="inlineCode">$1</code>');

  // Blockquotes: lines starting with > (but not emoticons like :> or =>)
  text = text.replace(/(?:^|(?<=\n))>(?![;:>])(.*)$/gm, '<span class="blockquote">&gt;$1</span>');

  return text;
}

/**
 * Strip all IRC formatting codes from text, returning plain text.
 */
export function stripIrcFormatting(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\x02\x1D\x1F\x16\x11\x1E\x0F]/g, '')
    .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
    .replace(/\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?/g, '');
}
