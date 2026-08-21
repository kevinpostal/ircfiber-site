import { describe, it, expect, beforeEach } from 'vitest';
import { checkHighlight } from '../stores/ircStore.svelte';
import { highlightWords } from '../stores/preferences.svelte';
import { wrapNicksWithHighlight } from './autolinker';

function createNetwork(currentNick: string) {
  return { currentNick, nick: currentNick } as any;
}
function createMessage(text: string, nick = 'redlegion') {
  return { text, nick, command: 'PRIVMSG', t: Date.now(), prefix: `${nick}!u@h` } as any;
}

describe('highlight false matches - Zodiac is my nick, not pancakes', () => {
  beforeEach(() => {
    highlightWords.length = 0;
  });

  it('pancakes: fair from redlegion should NOT highlight when my nick is Zodiac', () => {
    const net = createNetwork('Zodiac');
    const msg = createMessage('pancakes: fair');
    expect(checkHighlight(msg, net)).toBe(false);
  });

  it('pancakes: fair should NOT get mention span when my nick is Zodiac and no highlight words', () => {
    const myNick = 'Zodiac';
    const highlightSet = new Set<string>([myNick.toLowerCase()]);
    const allPattern = new RegExp(`(?<=^|[^a-zA-Z0-9_\\[\\]{}])(${['redlegion','pancakes','zodiac'].join('|')})(?=$|[^a-zA-Z0-9_\\[\\]{}])`, 'gi');
    const html = wrapNicksWithHighlight('pancakes: fair', allPattern, highlightSet);
    // Should be colored but NOT mention - mention class only for highlightSet
    expect(html).toContain('pancakes');
    expect(html).not.toContain('mention');
    expect(html).toContain('c12'); // color but not highlight
  });

  it('Zodiac: hello SHOULD highlight when my nick is Zodiac', () => {
    const net = createNetwork('Zodiac');
    const msg = createMessage('Zodiac: hello', 'alice');
    expect(checkHighlight(msg, net)).toBe(true);
    const highlightSet = new Set<string>(['zodiac']);
    const allPattern = new RegExp(`(?<=^|[^a-zA-Z0-9_\\[\\]{}])(zodiac)(?=$|[^a-zA-Z0-9_\\[\\]{}])`, 'gi');
    const html = wrapNicksWithHighlight('Zodiac: hello', allPattern, highlightSet);
    expect(html).toContain('mention');
  });

  it('substring should NOT cause false positive - pan should not highlight pancakes', () => {
    const net = createNetwork('pan');
    const msg = createMessage('pancakes: fair');
    // Fixed: checkHighlight now uses word boundaries, so pan does NOT match pancakes
    const includesResult = checkHighlight(msg, net);
    expect(includesResult).toBe(false);
    // The UI wrap also correctly does NOT highlight 'pan' inside 'pancakes'
    const highlightSet = new Set<string>(['pan']);
    const allPattern = new RegExp(`(?<=^|[^a-zA-Z0-9_\\[\\]{}])(pan)(?=$|[^a-zA-Z0-9_\\[\\]{}])`, 'gi');
    const html = wrapNicksWithHighlight('pancakes: fair', allPattern, highlightSet);
    expect(html).not.toContain('mention'); // regex correctly avoids substring
  });

  it('case insensitive - PANCakes should highlight Zodiac? no, Pancakes should not highlight Zodiac', () => {
    const net = createNetwork('Zodiac');
    const msg = createMessage('PANCakes: fair');
    // highlightSet is lowercased, so case insensitive should work for actual nick
    const highlightSet = new Set<string>(['zodiac']);
    const allPattern = new RegExp(`(?<=^|[^a-zA-Z0-9_\\[\\]{}])(zodiac)(?=$|[^a-zA-Z0-9_\\[\\]{}])`, 'gi');
    const html = wrapNicksWithHighlight('PANCakes: fair', allPattern, highlightSet);
    expect(html).not.toContain('mention');
  });
});
