/**
 * FIGlet banner generation for the MOTD editor. The renderer is a static
 * import; fonts are loaded on demand because the admin picks one at
 * runtime and each is a 5–30 KB string — bundling all 23 into the admin
 * chunk for a feature most sessions never open is the wrong trade.
 */
import figlet from 'figlet';
import type { FontName } from 'figlet';

/** Curated font list; the key is figlet's font name, the value its loader. */
export const FIGLET_FONTS: Record<string, () => Promise<{ default: string }>> = {
  // Runtime-selected by the font picker; see module comment.
  'ANSI Regular': () => import('figlet/importable-fonts/ANSI Regular.js'),
  'ANSI Shadow': () => import('figlet/importable-fonts/ANSI Shadow.js'),
  'Slant': () => import('figlet/importable-fonts/Slant.js'),
  'Big': () => import('figlet/importable-fonts/Big.js'),
  'Standard': () => import('figlet/importable-fonts/Standard.js'),
  'Small': () => import('figlet/importable-fonts/Small.js'),
  'Calvin S': () => import('figlet/importable-fonts/Calvin S.js'),
  'Banner3': () => import('figlet/importable-fonts/Banner3.js'),
  'Doom': () => import('figlet/importable-fonts/Doom.js'),
  'Larry 3D': () => import('figlet/importable-fonts/Larry 3D.js'),
  'Isometric1': () => import('figlet/importable-fonts/Isometric1.js'),
  'Delta Corps Priest 1': () => import('figlet/importable-fonts/Delta Corps Priest 1.js'),
  'Cyberlarge': () => import('figlet/importable-fonts/Cyberlarge.js'),
  'Bloody': () => import('figlet/importable-fonts/Bloody.js'),
  'Graffiti': () => import('figlet/importable-fonts/Graffiti.js'),
  'Colossal': () => import('figlet/importable-fonts/Colossal.js'),
  'Epic': () => import('figlet/importable-fonts/Epic.js'),
  'Rectangles': () => import('figlet/importable-fonts/Rectangles.js'),
  'Ogre': () => import('figlet/importable-fonts/Ogre.js'),
  'Elite': () => import('figlet/importable-fonts/Elite.js'),
  'Block': () => import('figlet/importable-fonts/Block.js'),
  'Shadow': () => import('figlet/importable-fonts/Shadow.js'),
  'Mini': () => import('figlet/importable-fonts/Mini.js'),
};

const loaded = new Set<string>();

/** Renders `text` in `font`; lines are right-trimmed and blank edges dropped. */
export async function renderFiglet(text: string, font: string): Promise<string> {
  const loader = FIGLET_FONTS[font];
  if (!loader) throw new Error(`unknown font: ${font}`);
  const name = font as FontName;
  if (!loaded.has(font)) {
    figlet.parseFont(name, (await loader()).default);
    loaded.add(font);
  }
  const lines = figlet.textSync(text, { font: name }).split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}
