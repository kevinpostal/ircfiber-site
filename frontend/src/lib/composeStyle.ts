// Outgoing-message styling picked in the compose gear dialog. Persisted in
// globalPrefs.composeStyle; applied at send time by composePipeline (lazy).
// This module stays tiny so it can live in chunk-core.

export type UnicodeStyle =
  | 'fullwidth'
  | 'bold'
  | 'italic'
  | 'boldItalic'
  | 'script'
  | 'fraktur'
  | 'doubleStruck'
  | 'monospace'
  | 'circled'
  | 'smallCaps'
  | 'upsideDown';

export type FontMode =
  | { kind: 'none' }
  | { kind: 'figlet'; font: string } // key of FIGLET_FONTS
  | { kind: 'tdf'; font: string } // TdfFontMeta.name
  | { kind: 'unicode'; style: UnicodeStyle };

export type ColorMode =
  | { kind: 'none' }
  | { kind: 'solid'; fg: number; bg: number | null } // 0–98
  | { kind: 'rainbow'; palette: 'classic' | 'smooth'; bg: number | null }
  | { kind: 'gradient'; from: number; to: number; bg: number | null }
  | { kind: 'wordCycle'; colors: number[]; bg: number | null }; // 1–8 codes

export type CaseMode = 'none' | 'upper' | 'lower' | 'mocking';

/** Word-wrap limit for FIGlet/TheDraw banners. `off` sends every art row
  whole (wide rows scroll); `word` folds between words at `width` columns
  so no glyph is ever cut mid-character. Clamped to 20–400 at render time. */
export type ArtWrapMode = 'off' | 'word';
export interface ArtWrap {
  mode: ArtWrapMode;
  width: number;
}

/** Clamp a user wrap width into the sane render range (20–400 columns). */
export function clampArtWrapWidth(width: number): number {
  if (!Number.isFinite(width)) return 80;
  return Math.min(400, Math.max(20, Math.floor(width)));
}

export interface ComposeStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  monospace: boolean;
  reverse: boolean;
  caseMode: CaseMode;
  zalgo: 0 | 1 | 2 | 3;
  color: ColorMode;
  font: FontMode;
  artWrap: ArtWrap;
}

export const DEFAULT_COMPOSE_STYLE: ComposeStyle = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  monospace: false,
  reverse: false,
  caseMode: 'none',
  zalgo: 0,
  color: { kind: 'none' },
  font: { kind: 'none' },
  artWrap: { mode: 'off', width: 80 },
};

export function isComposeStyleActive(s: ComposeStyle): boolean {
  return (
    s.bold ||
    s.italic ||
    s.underline ||
    s.strikethrough ||
    s.monospace ||
    s.reverse ||
    s.caseMode !== 'none' ||
    s.zalgo > 0 ||
    s.color.kind !== 'none' ||
    s.font.kind !== 'none'
  );
}

export const RAINBOW_CLASSIC = [4, 7, 8, 9, 11, 12, 13];
export const RAINBOW_SMOOTH = [52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63];
