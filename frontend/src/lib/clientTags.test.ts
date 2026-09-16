import { describe, it, expect } from 'vitest';
import { clientTagFeatures } from './clientTags';

/** A network the way a WS sync leaves it: ACKed caps plus raw 005 tokens. */
const net = (caps: string[], deny?: string) => ({
  capabilities: new Set(caps),
  isupport: deny === undefined ? {} : { CLIENTTAGDENY: deny },
});

describe('clientTagFeatures', () => {
  it('blocks every feature without message-tags, whatever ISUPPORT says', () => {
    // No cap ⇒ the server delivers no TAGMSG and the engine strips the tags
    // off an outgoing PRIVMSG, so a permissive CLIENTTAGDENY changes nothing.
    expect(clientTagFeatures(net([]))).toEqual({ reply: false, react: false, typing: false });
    expect(clientTagFeatures(net([], ''))).toEqual({ reply: false, react: false, typing: false });
  });

  it('allows everything with the cap and no advertised token', () => {
    expect(clientTagFeatures(net(['message-tags']))).toEqual({ reply: true, react: true, typing: true });
    expect(clientTagFeatures(net(['message-tags'], ''))).toEqual({ reply: true, react: true, typing: true });
  });

  it('blocks everything on a bare * (InspIRCd clientonlytags="none")', () => {
    expect(clientTagFeatures(net(['message-tags'], '*'))).toEqual({ reply: false, react: false, typing: false });
  });

  it('honours -name exemptions under the catch-all (clientonlytags="known")', () => {
    expect(clientTagFeatures(net(
      ['message-tags'],
      '*,-channel-context,-draft/channel-context,-draft/react,-draft/reply,-draft/unreact,-reply,-typing',
    ))).toEqual({ reply: true, react: true, typing: true });
  });

  it('keeps reactions off when the exemptions miss one reaction tag', () => {
    // A reaction needs +draft/react, +draft/unreact AND the +reply that names
    // its row: a half-allowed toggle would leave chips that silently fail.
    expect(clientTagFeatures(net(['message-tags'], '*,-reply,-typing')))
      .toEqual({ reply: true, react: false, typing: true });
  });

  it('treats a list without * as a blocklist', () => {
    expect(clientTagFeatures(net(['message-tags'], 'typing')))
      .toEqual({ reply: true, react: true, typing: false });
    expect(clientTagFeatures(net(['message-tags'], 'draft/unreact')))
      .toEqual({ reply: true, react: false, typing: true });
  });

  it('treats an unknown network as blocked', () => {
    expect(clientTagFeatures(undefined)).toEqual({ reply: false, react: false, typing: false });
    expect(clientTagFeatures(null)).toEqual({ reply: false, react: false, typing: false });
  });
});
