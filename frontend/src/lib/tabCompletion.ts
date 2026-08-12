import type { Member, TabCompletionCandidate } from '../types';
import { stripPrefix, naturalCompare } from './utils';

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

    // Nick completion (default)
    return this.getNickCandidates(word, members, myNick);
  }

  private getNickCandidates(word: string, members: Member[], myNick: string): TabCompletionCandidate[] {
    const lower = word.toLowerCase();
    return members
      .filter(m => {
        const nick = stripPrefix(m.nick).toLowerCase();
        return nick.startsWith(lower) && nick !== myNick.toLowerCase();
      })
      .sort((a, b) => {
        if (a.lastSpoke !== b.lastSpoke) return (b.lastSpoke || 0) - (a.lastSpoke || 0);
        if (a.lastHighlighted !== b.lastHighlighted) return (b.lastHighlighted || 0) - (a.lastHighlighted || 0);
        return naturalCompare(stripPrefix(a.nick), stripPrefix(b.nick));
      })
      .map(m => ({
        value: stripPrefix(m.nick),
        type: 'nick' as const,
        display: stripPrefix(m.nick),
        isAway: m.isAway,
        lastSpoke: m.lastSpoke,
      }));
  }

  private getCommandCandidates(partial: string): TabCompletionCandidate[] {
    const commands = [
      'nick', 'topic', 'away', 'back', 'invite', 'whois', 'ignore', 'unignore',
      'op', 'deop', 'voice', 'devoice', 'kick', 'ban', 'unban', 'kickban',
      'raw', 'umode', 'quit', 'part', 'me', 'cycle', 'clear', 'archive',
      'unarchive', 'delete', 'reconnect', 'highlight', 'unhighlight',
      'join', 'msg', 'notice', 'query',
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

  /**
   * Apply a completion candidate to the input.
   * Returns the new input string and cursor position.
   */
  apply(input: string, candidate: TabCompletionCandidate): { text: string; cursor: number } {
    let replacement = candidate.value;

    if (candidate.type === 'nick' && this.wordStart === 0) {
      replacement += ': ';
    } else if (candidate.type === 'nick') {
      replacement += ' ';
    } else if (candidate.type === 'command') {
      replacement += ' ';
    } else if (candidate.type === 'emoji') {
      replacement += ': ';
    }

    const before = input.slice(0, this.wordStart);
    const after = input.slice(this.wordEnd);
    const text = before + replacement + after;
    const cursor = before.length + replacement.length;
    // Update wordEnd so subsequent cycles replace the inserted word, not the original slice.
    this.wordEnd = this.wordStart + replacement.length;
    return { text, cursor };
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

export interface TabCompletionCycle {
  type: 'recentHighlighter' | 'nick' | 'channel' | 'command';
  value: string;
}

/** Per-buffer cache of nicks that recently highlighted the user.
 *  Keyed by `${networkId}:${bufferName}`, values = array of nicks
 *  (most recent first, max 10). */
export const recentHighlightersCache: Map<string, string[]> = new Map();
