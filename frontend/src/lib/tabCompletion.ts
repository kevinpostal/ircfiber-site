import type { Member, TabCompletionCandidate } from '../types';
import { stripPrefix, plainNick, naturalCompare } from './utils';

export class TabCompletionEngine {
  private candidates: TabCompletionCandidate[] = [];
  private currentIndex = -1;
  private originalWord = '';
  private wordStart = 0;
  private wordEnd = 0;

  get currentCandidates(): TabCompletionCandidate[] { return this.candidates; }
  get currentOriginalWord(): string { return this.originalWord; }
  get currentWordStart(): number { return this.wordStart; }
  get currentWordEnd(): number { return this.wordEnd; }
  get currentIdx(): number { return this.currentIndex; }
  /**
   * Get completion candidates for the current cursor position.
   */
  getCandidates(
    input: string,
    cursorPos: number,
    members: Member[],
    buffers: string[],
    myNick: string
  ): TabCompletionCandidate[] {
    const { word, start, end } = this.getWordAtCursor(input, cursorPos);
    this.originalWord = word;
    this.wordStart = start;
    this.wordEnd = end;

    if (!word) return [];

    // Command completion: / at start of line
    if (word.startsWith('/') && start === 0) {
      return this.getCommandCandidates(word.slice(1));
    }

    // Emoji completion: : prefix with at least 2 chars
    if (word.startsWith(':') && word.length >= 3) {
      return this.getEmojiCandidates(word.slice(1));
    }

    // Channel completion: starts with #
    if (word.startsWith('#')) {
      return buffers
        .filter(b => b.toLowerCase().startsWith(word.toLowerCase()))
        .map(b => ({ value: b, type: 'channel' as const, display: b }));
    }

    // Mention completion: @ prefix, Discord-style.
    if (word.startsWith('@')) {
      return mentionCandidates(word, members, myNick);
    }

    // Nick completion (default)
    return nickCandidates(word, members, myNick);
  }

  private getCommandCandidates(partial: string): TabCompletionCandidate[] {
    const commands = [
      'nick', 'topic', 'away', 'back', 'invite', 'whois', 'ignore', 'unignore',
      'op', 'deop', 'voice', 'devoice', 'kick', 'ban', 'unban', 'kickban',
      'raw', 'umode', 'quit', 'part', 'me', 'cycle', 'clear', 'archive',
      'unarchive', 'delete', 'reconnect', 'highlight', 'unhighlight',
      'join', 'msg', 'notice', 'query', 'list',
    ];
    const lower = partial.toLowerCase();
    return commands
      .filter(c => c.startsWith(lower))
      .sort()
      .map(c => ({ value: '/' + c, type: 'command' as const, display: '/' + c }));
  }

  private getEmojiCandidates(_partial: string): TabCompletionCandidate[] {
    // Placeholder -- emoji completion is bonus, not core IRC functionality
    return [];
  }

  private getWordAtCursor(input: string, pos: number): { word: string; start: number; end: number } {
    let start = pos;
    while (start > 0 && !/\s/.test(input[start - 1])) start--;
    let end = pos;
    while (end < input.length && !/\s/.test(input[end])) end++;
    return { word: input.slice(start, end), start, end };
  }

  /** Cycle to next candidate (Tab) or previous (Shift+Tab) */
  cycle(direction: 1 | -1): TabCompletionCandidate | null {
    if (this.candidates.length === 0) return null;
    this.currentIndex += direction;
    if (this.currentIndex >= this.candidates.length) this.currentIndex = 0;
    if (this.currentIndex < 0) this.currentIndex = this.candidates.length - 1;
    return this.candidates[this.currentIndex];
  }

  setCandidates(candidates: TabCompletionCandidate[]): void {
    this.candidates = candidates;
    this.currentIndex = -1;
  }

  reset(): void {
    this.candidates = [];
    this.currentIndex = -1;
    this.originalWord = '';
  }
}

/** The nicks of `members` which complete `word`, most recently active
 *  first. Own nick excluded — completing yourself is never what was
 *  meant. The typed prefix is matched against the nick as it reads
 *  (formatting stripped), but `value` is the RAW nick: it is what lands
 *  in the line, and the only way a typed `/msg` reaches a nick that
 *  carries formatting bytes. */
export function nickCandidates(word: string, members: Member[], myNick: string): TabCompletionCandidate[] {
  const lower = word.toLowerCase();
  const mine = plainNick(myNick).toLowerCase();
  return members
    .filter(m => {
      const nick = plainNick(m.nick).toLowerCase();
      return nick.startsWith(lower) && nick !== mine;
    })
    .sort((a, b) => {
      if (a.lastSpoke !== b.lastSpoke) return (b.lastSpoke || 0) - (a.lastSpoke || 0);
      if (a.lastHighlighted !== b.lastHighlighted) return (b.lastHighlighted || 0) - (a.lastHighlighted || 0);
      return naturalCompare(plainNick(a.nick), plainNick(b.nick));
    })
    .map(m => ({
      value: stripPrefix(m.nick),
      type: 'nick' as const,
      display: plainNick(m.nick),
      isAway: m.isAway,
      lastSpoke: m.lastSpoke,
    }));
}

/** Discord-style `@` mention candidates for a fragment that starts with
 *  `@`. `value` keeps the `@`, so the line that is sent reads "@nick" —
 *  which is what other IRC clients show and what the Discord bridge keys
 *  on when it turns the mention into a real ping. `display` keeps it too,
 *  so the picker's rows read exactly as what they insert. */
export function mentionCandidates(fragment: string, members: Member[], myNick: string): TabCompletionCandidate[] {
  if (!fragment.startsWith('@')) return [];
  return nickCandidates(fragment.slice(1), members, myNick)
    .map(c => ({ ...c, type: 'mention' as const, value: '@' + c.value, display: '@' + c.display }));
}

/** The `@` fragment the cursor sits in, or null. Discord-style: a run with
 *  no whitespace whose first character is `@`. */
export function mentionFragmentAt(input: string, cursorPos: number): { word: string; start: number; end: number } | null {
  let start = cursorPos;
  while (start > 0 && !/\s/.test(input[start - 1])) start--;
  if (input[start] !== '@') return null;
  let end = cursorPos;
  while (end < input.length && !/\s/.test(input[end])) end++;
  return { word: input.slice(start, end), start, end };
}

/** What a chosen candidate inserts, including its trailing separator.
 *  Single definition: `InputArea` renders through this too. */
export function replacementFor(candidate: TabCompletionCandidate, wordStart: number): string {
  if (candidate.type === 'nick') return candidate.value + (wordStart === 0 ? ': ' : ' ');
  if (candidate.type === 'emoji') return candidate.value + ': ';
  // mention / command / channel
  return candidate.value + ' ';
}

export interface TabCompletionCycle {
  type: 'recentHighlighter' | 'nick' | 'channel' | 'command';
  value: string;
}

/** Per-buffer cache of nicks that recently highlighted the user.
 *  Keyed by `${networkId}:${bufferName}`, values = array of nicks
 *  (most recent first, max 10). */
export const recentHighlightersCache: Map<string, string[]> = new Map();
