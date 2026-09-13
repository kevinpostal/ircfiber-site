import { escapeHtml } from './utils';
import { MODE_PREFIX_MAP } from '../types';

/** Prefix-mode letters, highest channel rank first. Mirrors MODE_HIERARCHY
 *  (OPER > OWNER > ADMIN > OP > HALFOP > VOICED); `y` (operprefix) and `Y`
 *  (ojoin) are the two OPER letters. */
const PREFIX_MODE_RANK = ['y', 'Y', 'q', 'a', 'o', 'h', 'v'] as const;

/** letter -> MODE_PREFIX_MAP entry ({ prefix, cls, category, mode, title }).
 *  Derived, never a second table: MODE_PREFIX_MAP stays the only source. */
type PrefixInfo = (typeof MODE_PREFIX_MAP)[string];
const BY_LETTER: Record<string, PrefixInfo | undefined> = Object.fromEntries(
  Object.values(MODE_PREFIX_MAP).map(e => [e.mode, e]),
);

const PHRASES: Record<string, [string, string]> = {
  q: ['promoted to owner', 'demoted from owner'],
  a: ['promoted to admin', 'demoted from admin'],
  o: ['opped', 'de-opped'],
  h: ['promoted to half-op', 'demoted from half-op'],
  v: ['voiced', 'de-voiced'],
  y: ['given oper status', 'lost oper status'],
  Y: ['given oper status', 'lost oper status'],
};

const LIST_ACTIONS: Record<string, [string, string]> = {
  b: ['banned', 'un-banned'],
  e: ['exempted', 'un-exempted'],
  I: ['invite-exempted', 'un-invite-exempted'],
};

// ISUPPORT `CHANMODES` classes, defaulted to the RFC/InspIRCd norm until a
// network advertises otherwise. Module-global with a setter, the same shape
// as `setChanPrefixChars` in `./autolinker` — `ircStore` feeds both from
// `applyIsupportUpdate`. Knowing which class a letter belongs to is what
// keeps `+ob nick mask` from handing the ban mask to the op sentence.
let listModes = 'beI';   // CHANMODES type A — always takes a mask
let argModes = 'k';      // type B — always takes an argument
let addArgModes = 'l';   // type C — argument only when adding

/** Feed ISUPPORT CHANMODES classes; empty/missing input restores the defaults. */
export function setChanModeTypes(a: string, b: string, c: string): void {
  listModes = a || 'beI';
  argModes = b || 'k';
  addArgModes = c || 'l';
}

export interface UserModeChange { nick: string; added: string[]; removed: string[]; }
export interface ListModeChange { letter: string; adding: boolean; mask: string; }
export interface ParsedModeLine {
  /** false when params[0] is not a channel target (user-mode line). */
  isChannel: boolean;
  users: UserModeChange[];              // first-seen order
  lists: ListModeChange[];              // b/e/I only
  /** remainder re-serialized, e.g. "+mk-t sekrit"; '' when none. */
  flags: string;
}

/**
 * Split a MODE line into per-user prefix-mode changes, list-mode (ban-like)
 * changes and a leftover flag string, consuming mode arguments according to
 * the ISUPPORT class each letter belongs to.
 */
export function parseModeLine(params: string[]): ParsedModeLine {
  if (!params || params.length < 2) {
    return { isChannel: false, users: [], lists: [], flags: '' };
  }
  const isChannel = /^[#&!+]/.test(params[0] || '');
  const modeStr = params[1] || '';
  const args = params.slice(2);
  let argIdx = 0;
  const takeArg = (): string | null => (argIdx < args.length ? args[argIdx++] : null);

  const userMap = new Map<string, { nick: string; added: Set<string>; removed: Set<string> }>();
  const lists: ListModeChange[] = [];
  // Flag remainder, built as sign-change-delimited runs plus their args.
  let flagLetters = '';
  let flagSign = '';
  const flagArgs: string[] = [];
  const pushFlag = (letter: string, adding: boolean, arg: string | null): void => {
    const sign = adding ? '+' : '-';
    if (sign !== flagSign) {
      flagLetters += sign;
      flagSign = sign;
    }
    flagLetters += letter;
    if (arg !== null) flagArgs.push(arg);
  };

  let adding = true;
  for (const ch of modeStr) {
    if (ch === '+') { adding = true; continue; }
    if (ch === '-') { adding = false; continue; }

    const prefixInfo = BY_LETTER[ch];
    if (prefixInfo) {
      const nick = takeArg();
      if (nick === null) { pushFlag(ch, adding, null); continue; }
      const key = nick.toLowerCase();
      let entry = userMap.get(key);
      if (!entry) {
        entry = { nick, added: new Set<string>(), removed: new Set<string>() };
        userMap.set(key, entry);
      }
      // Opposite signs cancel, so `+o-o alice alice` leaves nothing to say.
      if (adding) {
        if (entry.removed.delete(ch)) continue;
        entry.added.add(ch);
      } else {
        if (entry.added.delete(ch)) continue;
        entry.removed.add(ch);
      }
      continue;
    }

    if (listModes.includes(ch)) {
      const mask = takeArg();
      if (mask === null) { pushFlag(ch, adding, null); continue; }
      if (LIST_ACTIONS[ch]) lists.push({ letter: ch, adding, mask });
      else pushFlag(ch, adding, mask);
      continue;
    }

    if (argModes.includes(ch) || (adding && addArgModes.includes(ch))) {
      pushFlag(ch, adding, takeArg());
      continue;
    }

    pushFlag(ch, adding, null);
  }

  const users: UserModeChange[] = [];
  for (const e of userMap.values()) {
    if (!e.added.size && !e.removed.size) continue;   // `+o-o alice alice`
    users.push({ nick: e.nick, added: [...e.added], removed: [...e.removed] });
  }

  const flags = flagLetters
    ? (flagArgs.length ? `${flagLetters} ${flagArgs.join(' ')}` : flagLetters)
    : '';
  return { isChannel, users, lists, flags };
}

/**
 * Fold one parsed user-mode change into an accumulator keyed by lowercased
 * nick, so several MODE events inside one activity group collapse to a
 * single sentence per user (and a net-zero pair drops out entirely).
 */
export function mergeUserModeChange(into: Map<string, UserModeChange>, c: UserModeChange): void {
  const key = c.nick.toLowerCase();
  const cur = into.get(key);
  if (!cur) {
    into.set(key, { nick: c.nick, added: [...c.added], removed: [...c.removed] });
    return;
  }
  // Opposite signs across events cancel: `+o` then `-o` for one nick is a
  // net-zero change and leaves no phrase behind.
  for (const l of c.added) {
    if (cur.removed.includes(l)) { cur.removed = cur.removed.filter(x => x !== l); continue; }
    if (!cur.added.includes(l)) cur.added.push(l);
  }
  for (const l of c.removed) {
    if (cur.added.includes(l)) { cur.added = cur.added.filter(x => x !== l); continue; }
    if (!cur.removed.includes(l)) cur.removed.push(l);
  }
}

function rankOrder(letters: string[]): string[] {
  return PREFIX_MODE_RANK.filter(l => letters.includes(l));
}

/**
 * IRCCloud-style per-user sentence:
 * `mode: & • decoded (promoted to admin, opped)`.
 * The symbol/pill pair reflects the highest rank *added*; a pure removal
 * renders the nick unmoded because the resulting rank is unknowable from
 * the event alone.
 */
export function userModeSentence(c: UserModeChange, setter: string): string {
  const top = rankOrder(c.added)[0];
  const info = top ? BY_LETTER[top] : null;
  const phrases = [
    ...rankOrder(c.added).map(l => PHRASES[l]?.[0]).filter(Boolean),
    ...rankOrder(c.removed).map(l => PHRASES[l]?.[1]).filter(Boolean),
  ].join(', ');
  const setterTitle = setter ? ` title="Set by ${escapeHtml(setter)}"` : '';
  const nick = escapeHtml(c.nick);
  let symbols = '';
  let moded = '';
  if (info) {
    const title = escapeHtml(info.title);
    symbols =
      `<span title="${title}" class="mode_prefix mode_symbol ${info.cls}">${escapeHtml(info.prefix)}</span>` +
      `<span title="${title}" class="mode_prefix mode_pill ${info.cls}">&bull;</span>`;
    moded = `moded ${info.cls} `;
  }
  return `<span class="prefix">mode:</span> ${symbols}` +
    `<span class="buffer bufferLink ${moded}user link" data-name="${nick}">${nick}</span>` +
    ` (<span class="mode"${setterTitle}>${escapeHtml(phrases)}</span>)`;
}

/** Ban/exempt/invex sentence — keeps today's wording so ban lines read unchanged. */
export function listModeSentence(c: ListModeChange, setter: string): string {
  const action = LIST_ACTIONS[c.letter]?.[c.adding ? 0 : 1] || (c.adding ? 'set' : 'unset');
  const who = setter
    ? `<span class="buffer bufferLink user link" data-name="${escapeHtml(setter)}">${escapeHtml(setter)}</span> `
    : '';
  return `${who}${action} <b>${escapeHtml(c.mask)}</b> ` +
    `(<span class="mono rawMode">${c.adding ? '+' : '-'}${escapeHtml(c.letter)}</span>)`;
}

/** Leftover channel flags, e.g. `mode: +mk-t sekrit (set by op)`. */
export function flagModeSentence(flags: string, setter: string): string {
  const by = setter ? ` (<span class="mode">set by ${escapeHtml(setter)}</span>)` : '';
  return `<span class="prefix">mode:</span> <b>${escapeHtml(flags)}</b>${by}`;
}

/**
 * Full sentence list for one MODE event. `fallbackText` covers events that
 * carry only `text` (the engine's user-mode echo, e.g. `+Ziw`).
 */
export function modeSentences(params: string[], setter: string, fallbackText = ''): string[] {
  const parsed = parseModeLine(params);
  if (!params || params.length < 2) {
    if (!fallbackText) return [];
    return [`<span class="prefix">mode:</span> <b>${escapeHtml(fallbackText)}</b>`];
  }
  if (!parsed.isChannel) {
    return [`<span class="prefix">mode:</span> user mode <b>${escapeHtml(params.slice(1).join(' '))}</b>`];
  }
  const out = [
    ...parsed.users.map(u => userModeSentence(u, setter)),
    ...parsed.lists.map(l => listModeSentence(l, setter)),
  ];
  if (parsed.flags) out.push(flagModeSentence(parsed.flags, setter));
  return out;
}
