import { describe, it, expect, beforeEach } from 'vitest';
import {
  modeSentences, parseModeLine, setChanModeTypes, userModeSentence,
} from './modeSentence';

describe('parseModeLine', () => {
  beforeEach(() => setChanModeTypes('', '', ''));   // restore defaults

  it('splits a multi-letter prefix change into one target with both letters', () => {
    const parsed = parseModeLine(['#chan', '+ao', 'decoded', 'decoded']);
    expect(parsed.isChannel).toBe(true);
    expect(parsed.users).toEqual([{ nick: 'decoded', added: ['a', 'o'], removed: [] }]);
    expect(parsed.lists).toEqual([]);
    expect(parsed.flags).toBe('');
  });

  it('gives each mode its own argument when a prefix mode and a ban share a line', () => {
    // The old ban-only parser handed `nick` to the ban sentence.
    const parsed = parseModeLine(['#chan', '+ob', 'nick', '*!*@bad.host']);
    expect(parsed.users).toEqual([{ nick: 'nick', added: ['o'], removed: [] }]);
    expect(parsed.lists).toEqual([{ letter: 'b', adding: true, mask: '*!*@bad.host' }]);
  });

  it('cancels a +o/-o pair for the same nick on one line', () => {
    expect(parseModeLine(['#chan', '+o-o', 'alice', 'alice']).users).toEqual([]);
  });

  it('re-serialises non-prefix flags with their arguments', () => {
    const parsed = parseModeLine(['#chan', '+mk-t', 'sekrit']);
    expect(parsed.users).toEqual([]);
    expect(parsed.lists).toEqual([]);
    expect(parsed.flags).toBe('+mk-t sekrit');
  });

  it('consumes a type-C argument only while adding', () => {
    setChanModeTypes('beI', 'k', 'l');
    const parsed = parseModeLine(['#chan', '+l-l', '50']);
    expect(parsed.users).toEqual([]);
    expect(parsed.flags).toBe('+l-l 50');
  });

  it('treats a non-channel target as a user-mode line', () => {
    expect(parseModeLine(['alice', '+i']).isChannel).toBe(false);
  });
});

describe('modeSentences', () => {
  beforeEach(() => setChanModeTypes('', '', ''));

  it('renders symbol, pill, moded nick and phrase list for a prefix change', () => {
    const parsed = parseModeLine(['#chan', '+ao', 'decoded', 'decoded']);
    const html = userModeSentence(parsed.users[0], 'FIBERSERV');
    expect(html).toContain('mode_prefix mode_symbol mode_ADMIN">&amp;');
    expect(html).toContain('mode_prefix mode_pill mode_ADMIN');
    expect(html).toContain('moded mode_ADMIN');
    expect(html).toContain('>decoded<');
    expect(html).toContain('promoted to admin, opped');
    expect(html).toContain('title="Set by FIBERSERV"');
  });

  it('leaves the nick unmoded on a pure removal', () => {
    const parsed = parseModeLine(['#chan', '-o', 'bob']);
    const html = userModeSentence(parsed.users[0], 'op');
    expect(html).toContain('de-opped');
    expect(html).not.toContain('moded');
    expect(html).not.toContain('mode_symbol');
  });

  it('emits one sentence per affected user plus one for the ban', () => {
    const out = modeSentences(['#chan', '+ob', 'nick', '*!*@bad.host'], 'op');
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('opped');
    expect(out[1]).toContain('*!*@bad.host');
    expect(out[1]).toContain('banned');
  });

  it('labels a user-mode line', () => {
    expect(modeSentences(['alice', '+i'], 'alice')[0]).toContain('user mode');
  });

  it('falls back to the event text when the event carries no params', () => {
    const out = modeSentences([], 'me', '+Ziw');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('+Ziw');
  });

  it('escapes hostile nicks and masks', () => {
    const out = modeSentences(['#chan', '+b', '<img src=x>'], '<script>');
    expect(out[0]).not.toContain('<img');
    expect(out[0]).toContain('&lt;img');
  });
});
