// Pure string transforms for outgoing-message styling (no Svelte). Loaded
// lazily via composePipeline — keep it out of chunk-core.
import { RAINBOW_CLASSIC, RAINBOW_SMOOTH, type CaseMode, type ColorMode, type ComposeStyle, type UnicodeStyle } from './composeStyle';
import { colorHex } from './ircFormatting';

// ── Case ────────────────────────────────────────────────────────────────

export function applyCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'mocking': {
      let out = '';
      let upper = false;
      for (const ch of text) {
        const lo = ch.toLowerCase();
        const up = ch.toUpperCase();
        if (lo === up) {
          out += ch; // not a letter: does not advance the toggle
          continue;
        }
        out += upper ? up : lo;
        upper = !upper;
      }
      return out;
    }
    default:
      return text;
  }
}

// ── Unicode pseudo-fonts ────────────────────────────────────────────────

const A = 0x41;
const a = 0x61;
const ZERO = 0x30;

function mapAlnum(cp: number, upperBase: number | null, lowerBase: number | null, digitBase: number | null, ex?: Record<number, number>): number | null {
  if (ex && cp in ex) return ex[cp];
  if (upperBase !== null && cp >= A && cp <= A + 25) return upperBase + (cp - A);
  if (lowerBase !== null && cp >= a && cp <= a + 25) return lowerBase + (cp - a);
  if (digitBase !== null && cp >= ZERO && cp <= ZERO + 9) return digitBase + (cp - ZERO);
  return null;
}

const SMALL_CAPS = [...'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'];
const FLIP_LOWER = [...'ɐqɔpǝɟƃɥıɾʞlɯuodbɹsʇnʌʍxʎz'];
const FLIP_UPPER = [...'∀ꓭƆᗡƎℲ⅁HIſꓘ⅂WNOԀὉᴚS⊥∩ΛMX⅄Z'];
const FLIP_DIGIT = [...'0ƖᄅƐㄣϛ9ㄥ86'];
const FLIP_PUNCT: Record<string, string> = {
  '.': '˙', ',': "'", "'": ',', '?': '¿', '!': '¡',
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '_': '‾',
};

export function applyUnicodeStyle(text: string, style: UnicodeStyle): string {
  switch (style) {
    case 'smallCaps': {
      let out = '';
      for (const ch of text.toLowerCase()) {
        const cp = ch.codePointAt(0) as number;
        out += cp >= a && cp <= a + 25 ? SMALL_CAPS[cp - a] : ch;
      }
      return out;
    }
    case 'upsideDown': {
      const out: string[] = [];
      for (const ch of text) {
        const cp = ch.codePointAt(0) as number;
        if (cp >= a && cp <= a + 25) out.push(FLIP_LOWER[cp - a]);
        else if (cp >= A && cp <= A + 25) out.push(FLIP_UPPER[cp - A]);
        else if (cp >= ZERO && cp <= ZERO + 9) out.push(FLIP_DIGIT[cp - ZERO]);
        else out.push(FLIP_PUNCT[ch] ?? ch);
      }
      return out.reverse().join('');
    }
    case 'fullwidth': {
      let out = '';
      for (const ch of text) {
        const cp = ch.codePointAt(0) as number;
        if (cp === 0x20) out += '\u3000';
        else if (cp >= 0x21 && cp <= 0x7e) out += String.fromCodePoint(0xff01 + (cp - 0x21));
        else out += ch;
      }
      return out;
    }
    default: {
      let out = '';
      for (const ch of text) {
        const cp = ch.codePointAt(0) as number;
        let m: number | null;
        switch (style) {
          case 'bold': m = mapAlnum(cp, 0x1d400, 0x1d41a, 0x1d7ce); break;
          case 'italic': m = mapAlnum(cp, 0x1d434, 0x1d44e, null, { 0x68: 0x210e }); break;
          case 'boldItalic': m = mapAlnum(cp, 0x1d468, 0x1d482, null); break;
          case 'script': m = mapAlnum(cp, 0x1d4d0, 0x1d4ea, null); break;
          case 'fraktur': m = mapAlnum(cp, 0x1d56c, 0x1d586, null); break;
          case 'doubleStruck':
            m = mapAlnum(cp, 0x1d538, 0x1d552, 0x1d7d8, {
              0x43: 0x2102, 0x48: 0x210d, 0x4e: 0x2115, 0x50: 0x2119, 0x51: 0x211a, 0x52: 0x211d, 0x5a: 0x2124,
            });
            break;
          case 'monospace': m = mapAlnum(cp, 0x1d670, 0x1d68a, 0x1d7f6); break;
          case 'circled':
            if (cp === ZERO) m = 0x24ea;
            else if (cp > ZERO && cp <= ZERO + 9) m = 0x2460 + (cp - ZERO - 1);
            else m = mapAlnum(cp, 0x24b6, 0x24d0, null);
            break;
          default: m = null;
        }
        out += m === null ? ch : String.fromCodePoint(m);
      }
      return out;
    }
  }
}

// ── Zalgo ───────────────────────────────────────────────────────────────

const ZALGO_RANGE: Record<1 | 2 | 3, [number, number]> = { 1: [1, 2], 2: [2, 4], 3: [4, 8] };

export function applyZalgo(text: string, strength: 1 | 2 | 3): string {
  const [lo, hi] = ZALGO_RANGE[strength];
  let out = '';
  for (const ch of text) {
    out += ch;
    if (/\s/.test(ch)) continue;
    const k = lo + Math.floor(Math.random() * (hi - lo + 1));
    for (let i = 0; i < k; i++) out += String.fromCharCode(0x300 + Math.floor(Math.random() * 0x70));
  }
  return out;
}

// ── Colour ──────────────────────────────────────────────────────────────

const RGB: [number, number, number][] = [];
for (let code = 0; code <= 98; code++) {
  const hex = colorHex(code) as string;
  RGB.push([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
}

export function nearestIrcColor(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let code = 0; code < RGB.length; code++) {
    const [cr, cg, cb] = RGB[code];
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = code;
    }
  }
  return best;
}

function colorCode(fg: number, bg: number | null, withBg: boolean): string {
  const f = fg < 10 ? '0' + fg : String(fg);
  if (!withBg || bg === null) return '\x03' + f;
  return '\x03' + f + ',' + (bg < 10 ? '0' + bg : String(bg));
}

/** Emit IRC colour codes for `line` per `mode`; codes are always two digits. */
export function colorizeLine(line: string, mode: ColorMode): string {
  if (mode.kind === 'none' || line.trim() === '') return line;
  if (mode.kind === 'solid') return colorCode(mode.fg, mode.bg, true) + line;

  const chars = [...line];
  let nonSpace = 0;
  for (const ch of chars) if (!/\s/.test(ch)) nonSpace++;

  let fgAt: (i: number, word: number) => number;
  if (mode.kind === 'rainbow') {
    const palette = mode.palette === 'smooth' ? RAINBOW_SMOOTH : RAINBOW_CLASSIC;
    fgAt = (i) => palette[i % palette.length];
  } else if (mode.kind === 'gradient') {
    const from = RGB[mode.from];
    const to = RGB[mode.to];
    const denom = Math.max(1, nonSpace - 1);
    fgAt = (i) => {
      // Endpoints stay the picked codes: duplicate hexes (4/52, 0/98, …)
      // would otherwise quantize to the lower code.
      if (i === 0) return mode.from;
      if (i === nonSpace - 1) return mode.to;
      const t = i / denom;
      return nearestIrcColor(
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      );
    };
  } else {
    const colors = mode.colors.length ? mode.colors : [0];
    fgAt = (_i, w) => colors[w % colors.length];
  }

  let out = '';
  let i = 0;
  let word = -1;
  let inWord = false;
  let active: number | null = null;
  for (const ch of chars) {
    if (/\s/.test(ch)) {
      inWord = false;
      out += ch;
      continue;
    }
    if (!inWord) {
      inWord = true;
      word++;
    }
    const fg = fgAt(i, word);
    if (fg !== active) {
      out += colorCode(fg, mode.bg, active === null);
      active = fg;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Prefix attribute codes for each set flag; suffix a reset when anything was emitted. */
export function wrapAttrs(line: string, style: ComposeStyle): string {
  if (line.trim() === '') return line;
  let prefix = '';
  if (style.bold) prefix += '\x02';
  if (style.italic) prefix += '\x1D';
  if (style.underline) prefix += '\x1F';
  if (style.strikethrough) prefix += '\x1E';
  if (style.monospace) prefix += '\x11';
  if (style.reverse) prefix += '\x16';
  if (!prefix && !line.includes('\x03')) return line;
  return prefix + line + (line.endsWith('\x0F') ? '' : '\x0F');
}
