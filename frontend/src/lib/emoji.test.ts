import { describe, it, expect } from 'vitest';
import { isEmojiOnly } from './emoji';

/* `isEmojiOnly` drives the `onlyEmoji` row class (MessageRow.svelte) and
 * therefore the 32px/36px body — IRCCloud's `Message.isOnlyEmoji` →
 * `only_emoji` → `.emoji-big .only_emoji .content .emojinative`.
 *
 * The boundary that matters is emoji *presentation*: `▪▪▪`, `▶`, `©` and a
 * bare `☺`/`❤` are Extended_Pictographic but text-default, and they are
 * exactly what IRC box art is made of — enlarging those rows would wreck
 * column alignment, so presentation (default-emoji or an explicit U+FE0F)
 * is required.
 */
describe('isEmojiOnly', () => {
  it.each([
    ['one emoji', '🤔'],
    ['a run of emoji', '🤔🤔🤔'],
    ['emoji separated by a space', '🤔 🤔'],
    ['leading and trailing whitespace', '  🤔  '],
    ['a ZWJ family sequence', '👨‍👩‍👧‍👦'],
    ['a skin-tone modifier', '👍🏽'],
    ['two differently toned emoji', '👍🏿👍🏻'],
    ['a regional-indicator flag', '🇬🇧'],
    ['two flags', '🇬🇧🇺🇸'],
    ['a ZWJ flag with a variation selector', '🏳️‍🌈'],
    ['a tag-sequence flag', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'],
    ['a keycap', '1️⃣'],
    ['a text-default pictograph forced to emoji presentation', '☺️'],
    ['a heart with U+FE0F', '❤️'],
    ['a default-emoji dingbat', '⌚'],
    ['sparkles', '✨'],
    ['emoji-presentation geometric shapes', '⬛⬜🟩'],
    ['a ZWJ profession', '🧑‍🚀'],
    ['a skin tone plus a ZWJ profession', '👩🏾‍💻'],
    ['an emoji wrapped in mIRC colour codes', '\x0304🤔\x03'],
  ])('enlarges %s', (_label, text) => {
    expect(isEmojiOnly(text)).toBe(true);
  });

  it.each([
    ['words before an emoji', 'hello 🤔'],
    ['words after an emoji', '🤔 hi'],
    ['a trailing question mark', '🤔?'],
    ['a trailing bang', '🤔!'],
    ['a trailing full stop', '🤔.'],
    ['an unexpanded colon code', ':smile:'],
    ['a heart without U+FE0F', '❤'],
    ['a copyright sign', '©'],
    ['a text-presentation smiley', '☺'],
    ['box-art squares', '▪▪▪'],
    ['a text-presentation triangle', '▶'],
    ['punctuation alone', '!'],
    ['a letter', 'a'],
    ['an empty body', ''],
    ['whitespace alone', '   '],
    ['colour codes with no text', '\x0304\x03'],
  ])('leaves %s alone', (_label, text) => {
    expect(isEmojiOnly(text)).toBe(false);
  });
});
